"""
Shared email notifications for events that don't already have a home:
timetable/enrolment changes and role permission changes.

Follows the same plaintext send_mail + try/except-per-recipient pattern
used throughout the codebase (see billing/notifications.py), so a mail
outage never blocks the underlying CRUD action.
"""
import html
import logging
from urllib.parse import quote

from django.conf import settings
from django.core.mail import send_mail

from dynamo_backend.services import centres_db, roles_db
from global_access.capabilities import global_admin_emails
from notifications.tokens import MOVE_ACTION_MAX_AGE, make_move_action_token
from roles.permissions_catalog import PERMISSION_CATEGORIES

logger = logging.getLogger(__name__)

ADMIN_PERMISSION_KEYS = {'people.manage', 'roles.manage'}

_PERMISSION_LABELS = {
    key: label
    for entries in PERMISSION_CATEGORIES.values()
    for key, label in entries
}


def _is_admin_role(role):
    perms = {p.get('key') for p in role.get('permissions', []) if p.get('visible')}
    return ADMIN_PERMISSION_KEYS.issubset(perms)


def get_centre_admin_emails(centre_id):
    """Manager + members of any role with full people/roles admin at this centre."""
    emails = set()
    centre = centres_db.get_centre(str(centre_id))
    manager = (centre or {}).get('manager') or {}
    manager_email = manager.get('email')
    if manager_email:
        emails.add(manager_email)

    for role in roles_db.list_roles(str(centre_id)):
        if _is_admin_role(role):
            for member in role.get('members', []):
                if member.get('email'):
                    emails.add(member['email'])
    return emails


def _parent_contact_emails(child):
    return {
        c['email'] for c in child.get('contacts', [])
        if c.get('invite_as') in ('Parent', 'Guardian', 'Carer') and c.get('email')
    }


def _send(subject, message, emails):
    """
    Send to each recipient independently so one bad address can't block the rest.
    Never raises — a mail outage must not fail the underlying CRUD action — but
    logs every failure at ERROR so rejections are visible rather than silent.
    Returns a list of {'email', 'status', 'error'}, matching billing.notifications.
    """
    results = []
    for email in emails:
        try:
            send_mail(
                subject=subject,
                message=message,
                from_email=None,
                recipient_list=[email],
                fail_silently=False,
            )
            results.append({'email': email, 'status': 'sent', 'error': None})
        except Exception as e:
            # In the SES sandbox this is the expected failure for any recipient
            # that isn't itself a verified identity (MessageRejected).
            logger.error(f"Failed to send '{subject}' to {email}: {e}", exc_info=True)
            results.append({'email': email, 'status': 'failed', 'error': str(e)})

    if results and all(r['status'] == 'failed' for r in results):
        logger.error(f"'{subject}' failed for all {len(results)} recipient(s).")
    return results


def _slot_description(slot, session, room):
    day = (slot or {}).get('day', '').capitalize()
    time = (slot or {}).get('start_time', '')
    session_name = (session or {}).get('name', 'Session')
    room_name = (room or {}).get('name', '')
    parts = [session_name]
    if day or time:
        parts.append(f"{day} {time}".strip())
    if room_name:
        parts.append(f"Room: {room_name}")
    return " — ".join(parts)


def send_child_registered_email(child, centre):
    """Child registered successfully (onboarding email)."""
    child_name = f"{child.get('first_name', '')} {child.get('last_name', '')}".strip()
    centre_name = (centre or {}).get('name', '')

    subject = f"Welcome to Shichida — {child_name}"
    message = (
        f"Dear Parent/Guardian,\n\n"
        f"This email confirms that {child_name} has been successfully registered at {centre_name}.\n\n"
        f"We look forward to welcoming you.\n\n"
        f"Best regards,\n"
        f"{centre_name}"
    )

    emails = _parent_contact_emails(child)
    _send(subject, message, emails)


def send_enrolments_summary_email(child, centre, classes):
    """
    One email listing every class a child was booked into at once (at
    registration), instead of one email per class. `classes` is a list of
    (slot, session, room); weekly repeats of the same class are listed once.
    """
    if not classes:
        return
    child_name = f"{child.get('first_name', '')} {child.get('last_name', '')}".strip()
    centre_name = (centre or {}).get('name', '')

    # Week order (Mon first, then by time) so the list reads the way the week runs.
    days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    classes = sorted(classes, key=lambda c: (
        days.index((c[0] or {}).get('day')) if (c[0] or {}).get('day') in days else len(days),
        (c[0] or {}).get('start_time', ''),
    ))
    grouped = {}
    for slot, session, room in classes:
        grouped.setdefault(_slot_description(slot, session, room), []).append((slot or {}).get('start_date', ''))
    lines = []
    for description, dates in grouped.items():
        dates = sorted(d for d in dates if d)
        if len(dates) > 1:
            lines.append(f"  • {description} ({len(dates)} classes, {dates[0]} to {dates[-1]})")
        elif dates:
            lines.append(f"  • {description} ({dates[0]})")
        else:
            lines.append(f"  • {description}")

    subject = f"Sessions scheduled — {child_name}"
    message = (
        f"Dear Parent/Guardian,\n\n"
        f"{child_name} has been booked into the following sessions at {centre_name}:\n\n"
        + "\n".join(lines) + "\n\n"
        f"Best regards,\n"
        f"{centre_name}"
    )

    emails = _parent_contact_emails(child)
    _send(subject, message, emails)


def send_enrolment_added_email(child, slot, session, centre, room=None):
    """Child added to a timetable slot (Req: timetable planned / child added)."""
    child_name = f"{child.get('first_name', '')} {child.get('last_name', '')}".strip()
    centre_name = (centre or {}).get('name', '')
    description = _slot_description(slot, session, room)

    subject = f"New session scheduled — {child_name}"
    message = (
        f"Dear Parent/Guardian,\n\n"
        f"{child_name} has been added to a new session at {centre_name}.\n\n"
        f"{description}\n\n"
        f"Best regards,\n"
        f"{centre_name}"
    )

    emails = _parent_contact_emails(child)
    _send(subject, message, emails)


def send_enrolment_removed_email(child, slot, session, centre, reason='removed', room=None):
    """
    Child removed from a slot, or moved to a different slot (Req: child
    removed / slot changes). `reason` is 'removed' or 'rescheduled'.
    """
    child_name = f"{child.get('first_name', '')} {child.get('last_name', '')}".strip()
    centre_name = (centre or {}).get('name', '')
    description = _slot_description(slot, session, room)

    if reason == 'rescheduled':
        subject = f"Session time changed — {child_name}"
        intro = f"{child_name}'s session at {centre_name} has been rescheduled."
    else:
        subject = f"Session removed — {child_name}"
        intro = f"{child_name} has been removed from a session at {centre_name}."

    message = (
        f"Dear Parent/Guardian,\n\n"
        f"{intro}\n\n"
        f"{description}\n\n"
        f"Best regards,\n"
        f"{centre_name}"
    )

    emails = _parent_contact_emails(child)
    _send(subject, message, emails)


def send_permission_updated_email(role, changed_summary):
    """
    A role's permissions changed (Req: role permission updated/changed).
    `changed_summary` is a list of (key, {'visible': bool, 'edit': bool}) tuples.
    """
    role_name = role.get('name', 'Role')

    lines = []
    for key, flags in changed_summary:
        label = _PERMISSION_LABELS.get(key, key)
        access = 'edit' if flags.get('edit') else ('view only' if flags.get('visible') else 'no access')
        lines.append(f"  - {label}: {access}")
    changes_text = "\n".join(lines) if lines else "  (see the portal for the latest permissions)"

    subject = f"Permissions updated — {role_name}"
    message = (
        f"Hi,\n\n"
        f"The permissions for the \"{role_name}\" role have been updated:\n\n"
        f"{changes_text}\n\n"
        f"Log in to the portal to review your access.\n\n"
        f"Best regards,\n"
        f"Shichida India Admin Portal"
    )

    emails = {m['email'] for m in role.get('members', []) if m.get('email')}
    centre_id = role.get('centre_id')
    if centre_id:
        emails |= get_centre_admin_emails(centre_id)
    _send(subject, message, emails)


def send_staff_invite_email(person, role, centre_id=None):
    """
    Invite a newly-onboarded staff member to set their password and sign in
    (Global settings → People → Onboard staff, step 3).

    Mirrors the wizard's preview text so what the admin was shown is what
    actually goes out. Returns the same {'sent', 'reason', 'results'} shape
    as billing.notifications.send_invoice_email so callers can report back.
    """
    email = person.get('email')
    if not email:
        return {'sent': False, 'reason': 'no_email', 'results': []}

    first_name = (person.get('name') or '').split(' ')[0]
    role_name = (role or {}).get('name', 'staff member')

    centre_name = ''
    if centre_id:
        centre = centres_db.get_centre(str(centre_id))
        centre_name = (centre or {}).get('name', '')
    where = f"{role_name} at {centre_name}" if centre_name else role_name

    granted = sum(
        1 for p in (role or {}).get('permissions', [])
        if p.get('visible') or p.get('edit')
    )

    # Accounts are created with a random password nobody is told, so the
    # first login goes through the reset flow — that's why this walks them
    # to "Forgot your password?" rather than mentioning a password we set.
    subject = f"You have been set up on Shichida India — {where}"
    message = (
        f"Hello {first_name},\n\n"
        f"You have been set up on Shichida India as {where}.\n\n"
        f"Best regards,\n"
        f"Shichida India Admin Portal"
    )

    results = _send(subject, message, [email])
    sent = any(r['status'] == 'sent' for r in results)
    return {
        'sent': sent,
        'reason': None if sent else 'send_failed',
        'results': results,
    }


# ── Child move requests ─────────────────────────────────────────────
# A centre asks; a Global Admin decides. Both halves are told what happened,
# because a request nobody hears about is a child stuck between centres.


def get_global_admin_emails():
    """
    Everyone who can decide a move request — the Super Admins.
    """
    from global_access.capabilities import super_admin_emails
    return set(super_admin_emails())


def move_action_urls(move_request_id, email):
    """
    The approve and reject links for one recipient.

    Both point at the confirmation page, not at the API: the page shows the
    move and asks for a click before anything happens, so a mail scanner
    prefetching the link cannot decide a child's move on the admin's behalf.
    The token is minted per recipient, so a forwarded link still says who it
    was sent to.
    """
    token = make_move_action_token(move_request_id, email)
    base = f"{settings.FRONTEND_URL.rstrip('/')}/child-moves/action?token={quote(token, safe='')}"
    return {
        'approve': f"{base}&action=approve",
        'reject': f"{base}&action=reject",
        'token': token,
    }


def _child_name(child):
    return f"{(child or {}).get('first_name', '')} {(child or {}).get('last_name', '')}".strip()


def _move_summary_rows(child, from_centre, to_centre, move_request):
    rows = [
        ('Child', _child_name(child) or '(unnamed)'),
        ('Child ID', (child or {}).get('system_id') or (child or {}).get('id', '')),
        ('Current centre', (from_centre or {}).get('name', '')),
        ('Requested centre', (to_centre or {}).get('name', '')),
        ('Requested by', move_request.get('requested_by', '')),
        ('Requested on', move_request.get('requested_at', '')),
    ]
    if move_request.get('reason'):
        rows.append(('Reason', move_request['reason']))
    return rows


def _move_summary(child, from_centre, to_centre, move_request):
    return "".join(
        f"{label}: {value}\n"
        for label, value in _move_summary_rows(child, from_centre, to_centre, move_request)
    )


def _move_request_text(child, from_centre, to_centre, move_request, urls):
    days = MOVE_ACTION_MAX_AGE // (24 * 60 * 60)
    return (
        f"A centre has asked to move a child to another centre. The child has "
        f"not moved — this is waiting for your decision.\n\n"
        f"{_move_summary(child, from_centre, to_centre, move_request)}\n"
        f"Approve this transfer:\n{urls['approve']}\n\n"
        f"Reject this transfer:\n{urls['reject']}\n\n"
        f"Either link opens a page where you can review the move, add a note "
        f"and confirm. Nothing happens until you confirm there. These links are "
        f"for you only and stop working after {days} days.\n\n"
        f"You can also decide in the admin portal under "
        f"Global settings → Child moves.\n\n"
        f"Approving moves the child to the requested centre and takes the "
        f"current centre's invoices off them. Rejecting changes nothing.\n\n"
        f"Best regards,\n"
        f"Shichida India Admin Portal"
    )


_EMAIL_BUTTON = (
    '<a href="{href}" style="display:inline-block;padding:12px 22px;border-radius:6px;'
    'font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;'
    'background:{bg};border:1px solid {bg};">{label}</a>'
)


def _move_request_html(child, from_centre, to_centre, move_request, urls):
    """
    The HTML body of the approval email: the move in a table, then a green
    Approve and a red Reject button. Table layout and inline styles because
    that is what mail clients render; no external assets because most block
    them. Everything user-supplied is escaped.
    """
    esc = html.escape
    rows = "".join(
        '<tr>'
        f'<td style="padding:6px 12px 6px 0;color:#6b6b66;font-size:14px;white-space:nowrap;">{esc(str(label))}</td>'
        f'<td style="padding:6px 0;color:#2f2f2b;font-size:14px;font-weight:600;">{esc(str(value))}</td>'
        '</tr>'
        for label, value in _move_summary_rows(child, from_centre, to_centre, move_request)
    )
    days = MOVE_ACTION_MAX_AGE // (24 * 60 * 60)
    to_name = esc((to_centre or {}).get('name', '') or 'the requested centre')
    from_name = esc((from_centre or {}).get('name', '') or 'the current centre')
    approve = _EMAIL_BUTTON.format(href=esc(urls['approve']), bg='#2e7d32', label='Approve Transfer')
    reject = _EMAIL_BUTTON.format(href=esc(urls['reject']), bg='#c62828', label='Reject Transfer')

    return (
        '<!DOCTYPE html>'
        '<html><body style="margin:0;padding:0;background:#f4f2ee;font-family:Arial,Helvetica,sans-serif;">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f2ee;padding:24px 12px;">'
        '<tr><td align="center">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" '
        'style="max-width:560px;background:#ffffff;border:1px solid #e3ddd3;border-radius:12px;">'
        '<tr><td style="padding:24px 28px 8px 28px;">'
        '<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5b6653;font-weight:700;">Shichida India</div>'
        '<h1 style="margin:8px 0 0 0;font-size:20px;color:#2f2f2b;">A child move needs your approval</h1>'
        '<p style="margin:12px 0 0 0;font-size:14px;line-height:1.5;color:#4a4a45;">'
        'A centre has asked to move a child to another centre. The child has '
        '<strong>not</strong> moved &mdash; this is waiting for your decision.'
        '</p></td></tr>'
        '<tr><td style="padding:12px 28px;">'
        '<table role="presentation" cellspacing="0" cellpadding="0" '
        'style="width:100%;border-top:1px solid #eee9e1;border-bottom:1px solid #eee9e1;">'
        f'{rows}'
        '</table></td></tr>'
        '<tr><td align="center" style="padding:16px 28px 8px 28px;">'
        '<table role="presentation" cellspacing="0" cellpadding="0"><tr>'
        f'<td style="padding:6px;">{approve}</td>'
        f'<td style="padding:6px;">{reject}</td>'
        '</tr></table></td></tr>'
        '<tr><td style="padding:8px 28px 24px 28px;font-size:13px;line-height:1.5;color:#6b6b66;">'
        '<p style="margin:0 0 8px 0;">Either button opens a page where you can review the move, '
        'add a note, and confirm. Nothing happens until you confirm there.</p>'
        f'<p style="margin:0 0 8px 0;">Approving moves the child to {to_name} and takes '
        f'{from_name}&rsquo;s invoices off them. Rejecting changes nothing.</p>'
        f'<p style="margin:0;">These links are for you only and stop working after {days} days. '
        'You can also decide in the admin portal under Global settings &rarr; Child moves.</p>'
        '</td></tr>'
        '</table></td></tr></table></body></html>'
    )


def send_move_request_email(move_request, child, from_centre, to_centre):
    """
    Tell the Global Admins a move is waiting on them, with Approve and Reject
    buttons they can act on from the email (Req: move needs approval).

    Each recipient gets their own message, because the links in it carry a
    token signed for that recipient. Returns the same {'sent', 'reason',
    'results'} shape the rest of this module uses, so the API can say whether
    anyone was actually told.
    """
    name = _child_name(child)
    subject = f"Approval needed: move {name or 'a child'} to {(to_centre or {}).get('name', 'another centre')}"

    emails = get_global_admin_emails()
    if not emails:
        logger.error(
            "Move request %s created but no Global Admin has an address to notify.",
            move_request.get('id'),
        )
        return {'sent': False, 'reason': 'no_admins', 'results': []}

    results = []
    for email in sorted(emails):
        urls = move_action_urls(move_request.get('id'), email)
        message = _move_request_text(child, from_centre, to_centre, move_request, urls)
        html_message = _move_request_html(child, from_centre, to_centre, move_request, urls)
        try:
            send_mail(
                subject=subject,
                message=message,
                from_email=None,
                recipient_list=[email],
                fail_silently=False,
                html_message=html_message,
            )
            results.append({'email': email, 'status': 'sent', 'error': None})
        except Exception as e:
            logger.error(f"Failed to send '{subject}' to {email}: {e}", exc_info=True)
            results.append({'email': email, 'status': 'failed', 'error': str(e)})

    sent = any(r['status'] == 'sent' for r in results)
    if not sent:
        logger.error(f"'{subject}' failed for all {len(results)} recipient(s).")
    return {'sent': sent, 'reason': None if sent else 'all_failed', 'results': results}


def send_move_decision_email(move_request, child, from_centre, to_centre, approved):
    """
    Tell the centre that asked what was decided.

    Best-effort and never raises: the decision is already recorded and the
    child already moved or did not, so a mail failure must not undo it.
    """
    name = _child_name(child)
    outcome = 'approved' if approved else 'rejected'
    subject = f"Move request {outcome}: {name or 'child'}"

    if approved:
        tail = (
            f"{name} is now at {(to_centre or {}).get('name', 'the requested centre')}. "
            f"Invoices raised at {(from_centre or {}).get('name', 'the previous centre')} "
            f"stay in that centre's records and are no longer on the child.\n"
        )
    else:
        tail = (
            f"{name} stays at {(from_centre or {}).get('name', 'the current centre')}. "
            f"Nothing has changed, invoices included.\n"
        )

    note = move_request.get('decision_note')
    message = (
        f"A request to move a child between centres was {outcome}.\n\n"
        f"{_move_summary(child, from_centre, to_centre, move_request)}"
        f"Decided by: {move_request.get('decided_by', '')}\n"
        + (f"Note: {note}\n" if note else '')
        + f"\n{tail}\n"
        f"Best regards,\n"
        f"Shichida India Admin Portal"
    )

    emails = get_global_admin_emails()
    if not emails:
        return {'sent': False, 'reason': 'no_recipients', 'results': []}

    results = _send(subject, message, emails)
    sent = any(r['status'] == 'sent' for r in results)
    return {'sent': sent, 'reason': None if sent else 'all_failed', 'results': results}
