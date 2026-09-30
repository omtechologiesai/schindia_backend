from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from schindia_auth.permissions import IsApprovedUser
from dynamo_backend.services import children_db, progress_db, sessions_db, centres_db
from dynamo_backend.services.children_service import is_archived
from notifications.mailer import send_enrolment_added_email, send_enrolment_removed_email, send_child_registered_email
from roles.access import get_user_access, centre_not_found, permission_denied
from .serializers import ContactSerializer, ChildEnrolmentSerializer

# What ?status= on the children list means. The default is the active roll:
# an archived child has been taken off it deliberately, and reappearing in
# every list is exactly what archiving is meant to stop.
ARCHIVE_FILTERS = {'active': False, 'archived': True, 'all': None}


def _resolve_enrolment_context(enrolment):
    """Look up child/slot/session/centre/room for an enrolment's slot, for notification emails."""
    child_id = enrolment.get('child_id') or enrolment.get('child')
    slot_id = enrolment.get('slot_id') or enrolment.get('slot')
    child = children_db.get_child(str(child_id)) if child_id else None
    slot = sessions_db.get_slot(str(slot_id)) if slot_id else None
    centre_id = (child or {}).get('centre_id') or (slot or {}).get('centre_id')
    session = sessions_db.get_session(str(slot['session_id']), centre_id=centre_id) if slot and slot.get('session_id') else None
    centre = centres_db.get_centre(str(centre_id)) if centre_id else None
    room = centres_db.get_room(str(slot['room_id'])) if slot and slot.get('room_id') else None
    return child, slot, session, centre, room


class ChildViewSet(viewsets.ViewSet):
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        centre_pk = self.kwargs.get('centre_pk') or request.query_params.get('centre')
        if not centre_pk:
            # Require centre filter — don't expose full table scan of children's data
            return Response(
                {'detail': 'centre query parameter is required.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_pk):
            return centre_not_found()
        if not access.can_view(centre_pk, 'children.view_info'):
            return permission_denied()

        wanted = (request.query_params.get('status') or 'active').strip().lower()
        if wanted not in ARCHIVE_FILTERS:
            return Response(
                {'status': [
                    "Must be one of: " + ', '.join(sorted(ARCHIVE_FILTERS))]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        children = children_db.list_children(
            str(centre_pk), archived=ARCHIVE_FILTERS[wanted])
        return Response(children)

    def retrieve(self, request, *args, **kwargs):
        child = children_db.get_child(str(kwargs['pk']))
        if not child:
            return Response({'detail': 'Child not found.'}, status=status.HTTP_404_NOT_FOUND)
        # Scope check: if centre_pk in URL, verify child belongs to it
        centre_pk = self.kwargs.get('centre_pk')
        if centre_pk and child.get('centre_id') != str(centre_pk):
            return Response({'detail': 'Child not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = child.get('centre_id')
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_view(centre_id, 'children.view_info'):
            return permission_denied()
        return Response(child)

    def create(self, request, *args, **kwargs):
        from datetime import date, datetime

        data = request.data.copy()
        # Handle centre_id from URL or body
        if self.kwargs.get('centre_pk'):
            data['centre_id'] = str(self.kwargs['centre_pk'])
        elif data.get('centre'):
            data['centre_id'] = str(data.pop('centre'))

        if data.get('session'):
            data['session_id'] = str(data.pop('session'))

        # Required field validation
        required_fields = ['first_name', 'last_name', 'gender', 'date_of_birth', 'start_date']
        missing = [f for f in required_fields if not data.get(f)]
        if missing:
            return Response(
                {f: ['This field is required.'] for f in missing},
                status=status.HTTP_400_BAD_REQUEST
            )
        if not data.get('centre_id'):
            return Response(
                {'centre': ['Centre is required.']},
                status=status.HTTP_400_BAD_REQUEST
            )

        access = get_user_access(request.user, request)
        if not access.can_access_centre(data['centre_id']):
            return centre_not_found()
        if not access.can_edit(data['centre_id'], 'children.add'):
            return permission_denied()

        # Validate date_of_birth and start_date
        dob_str = data.get('date_of_birth')
        start_date_str = data.get('start_date')
        try:
            dob = datetime.strptime(dob_str, '%Y-%m-%d').date()
            if dob > date.today():
                return Response(
                    {'date_of_birth': ['Date of birth cannot be in the future.']},
                    status=status.HTTP_400_BAD_REQUEST
                )
            start_dt = datetime.strptime(start_date_str, '%Y-%m-%d').date()
            if start_dt < dob:
                return Response(
                    {'start_date': ['Start date cannot be before date of birth.']},
                    status=status.HTTP_400_BAD_REQUEST
                )
        except (ValueError, TypeError):
            return Response(
                {'date_of_birth': ['Invalid date format. Use YYYY-MM-DD.']},
                status=status.HTTP_400_BAD_REQUEST
            )

        child = children_db.create_child(data)
        
        centre = centres_db.get_centre(str(child.get('centre_id'))) if child.get('centre_id') else None



        # Send onboarding email
        if centre:
            send_child_registered_email(child, centre)

        return Response(child, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        child = children_db.get_child(str(kwargs['pk']))
        if not child:
            return Response({'detail': 'Child not found.'}, status=status.HTTP_404_NOT_FOUND)
        # Scope check
        centre_pk = self.kwargs.get('centre_pk')
        if centre_pk and child.get('centre_id') != str(centre_pk):
            return Response({'detail': 'Child not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = child.get('centre_id')
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'children.view_info'):
            return permission_denied()

        data = request.data.copy()
        if 'centre' in data:
            data['centre_id'] = data.pop('centre')
        if 'session' in data:
            data['session_id'] = data.pop('session')

        updated = children_db.update_child(str(kwargs['pk']), data)
        return Response(updated)

    def destroy(self, request, *args, **kwargs):
        child_id = str(kwargs['pk'])

        child = children_db.get_child(child_id)
        if not child:
            return Response({'detail': 'Child not found.'}, status=status.HTTP_404_NOT_FOUND)
        # Scope check
        centre_pk = self.kwargs.get('centre_pk')
        if centre_pk and child.get('centre_id') != str(centre_pk):
            return Response({'detail': 'Child not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = child.get('centre_id')
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'children.view_info'):
            return permission_denied()

        # Cascade: delete related records to prevent orphans
        # Contacts
        for contact in children_db.list_contacts(child_id):
            children_db.delete_contact(contact['id'])
        # Enrolments (also removes child from slot child_ids)
        for enrolment in children_db.list_enrolments(child_id):
            children_db.delete_enrolment(enrolment['id'])
        # Attendance
        for record in progress_db.list_attendance(child_id):
            progress_db.delete_attendance(record['id'])
        # Journey entries
        for entry in progress_db.list_journey(child_id):
            progress_db.delete_journey_entry(entry['id'])
        # Notes
        for note in progress_db.list_notes(child_id):
            progress_db.delete_note(note['id'])

        children_db.delete_child(child_id)
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _child_for_status_change(self, request, pk):
        """
        Fetch a child and check the caller may change its status.

        Returns (child, error_response). The child id comes from the URL and
        is never trusted on its own — a caller who can see one centre must not
        be able to archive another centre's child by editing the id.
        """
        child = children_db.get_child(str(pk))
        if not child:
            return None, Response({'detail': 'Child not found.'},
                                  status=status.HTTP_404_NOT_FOUND)

        centre_pk = self.kwargs.get('centre_pk')
        if centre_pk and child.get('centre_id') != str(centre_pk):
            return None, Response({'detail': 'Child not found.'},
                                  status=status.HTTP_404_NOT_FOUND)

        centre_id = child.get('centre_id')
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            # Not found rather than forbidden — a 403 would confirm the child
            # exists at a centre the caller cannot see.
            return None, centre_not_found('Child not found.')
        if not access.can_edit(centre_id, 'children.register_status'):
            return None, permission_denied()
        return child, None

    @action(detail=True, methods=['post'])
    def archive(self, request, pk=None, *args, **kwargs):
        """
        Take a child off the active roll.

        Nothing is deleted: the record, its contacts, bookings, journey and
        invoices all stay exactly where they are. Archiving answers "stop
        showing me this child day to day", not "forget this child ever came".
        """
        child, error = self._child_for_status_change(request, pk)
        if error:
            return error
        if is_archived(child):
            # Already where the caller is asking for it to be. Saying so beats
            # failing a repeated click, and beats writing a second archive date
            # over the real one.
            return Response(child)
        return Response(children_db.archive_child(
            str(pk), archived_by=_actor(request)))

    @action(detail=True, methods=['post'])
    def unarchive(self, request, pk=None, *args, **kwargs):
        """Put an archived child back on the active roll."""
        child, error = self._child_for_status_change(request, pk)
        if error:
            return error
        if not is_archived(child):
            return Response(child)
        return Response(children_db.unarchive_child(str(pk)))


def _actor(request):
    """Who performed an act, for the audit line on it."""
    user = request.user
    return getattr(user, 'email', '') or str(getattr(user, 'id', ''))


def _child_centre_id(child_id):
    """Resolve the centre a child belongs to, for scope/permission checks."""
    if not child_id:
        return None
    child = children_db.get_child(str(child_id))
    return child.get('centre_id') if child else None


class ContactViewSet(viewsets.ViewSet):
    serializer_class = ContactSerializer
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response([])
        centre_id = _child_centre_id(child_pk)
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_view(centre_id, 'children.view_info'):
            return permission_denied()
        contacts = children_db.list_contacts(str(child_pk))
        return Response(contacts)

    def retrieve(self, request, *args, **kwargs):
        contact = children_db.get_contact(str(kwargs['pk']))
        if not contact:
            return Response({'detail': 'Contact not found.'}, status=status.HTTP_404_NOT_FOUND)
        child_pk = self.kwargs.get('child_pk')
        if child_pk and contact.get('child_id') != str(child_pk):
            return Response({'detail': 'Contact not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = _child_centre_id(contact.get('child_id'))
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_view(centre_id, 'children.view_info'):
            return permission_denied()
        return Response(contact)

    def create(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response({'detail': 'A child is required to create a contact.'}, status=status.HTTP_400_BAD_REQUEST)

        centre_id = _child_centre_id(child_pk)
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'children.manage_contacts'):
            return permission_denied()

        data = request.data.copy()

        # Required field validation for contacts
        required_fields = ['name', 'relation', 'phone', 'email']
        missing = [f for f in required_fields if not data.get(f)]
        if missing:
            return Response(
                {f: ['This field is required.'] for f in missing},
                status=status.HTTP_400_BAD_REQUEST
            )

        contact = children_db.create_contact(str(child_pk), data)
        return Response(contact, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        contact = children_db.get_contact(str(kwargs['pk']))
        if not contact:
            return Response({'detail': 'Contact not found.'}, status=status.HTTP_404_NOT_FOUND)
        # Scope check: verify contact belongs to the child in URL
        child_pk = self.kwargs.get('child_pk')
        if child_pk and contact.get('child_id') != str(child_pk):
            return Response({'detail': 'Contact not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = _child_centre_id(contact.get('child_id'))
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'children.manage_contacts'):
            return permission_denied()

        updated = children_db.update_contact(str(kwargs['pk']), request.data)
        return Response(updated)

    def destroy(self, request, *args, **kwargs):
        contact = children_db.get_contact(str(kwargs['pk']))
        if not contact:
            return Response({'detail': 'Contact not found.'}, status=status.HTTP_404_NOT_FOUND)
        # Scope check
        child_pk = self.kwargs.get('child_pk')
        if child_pk and contact.get('child_id') != str(child_pk):
            return Response({'detail': 'Contact not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = _child_centre_id(contact.get('child_id'))
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'children.manage_contacts'):
            return permission_denied()

        children_db.delete_contact(str(kwargs['pk']))
        return Response(status=status.HTTP_204_NO_CONTENT)


class EnrolmentViewSet(viewsets.ViewSet):
    serializer_class = ChildEnrolmentSerializer
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response([])
        centre_id = _child_centre_id(child_pk)
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_view(centre_id, 'children.view_info'):
            return permission_denied()
        # ?include_cancelled=1 for the activity feed, which shows a place
        # ending as an event. Everything else wants current bookings only.
        include_cancelled = str(
            request.query_params.get('include_cancelled', '')
        ).lower() in ('1', 'true', 'yes')
        enrolments = children_db.list_enrolments(
            str(child_pk), include_cancelled=include_cancelled)
        return Response(enrolments)

    def create(self, request, *args, **kwargs):
        data = request.data.copy()
        child_pk = self.kwargs.get('child_pk') or data.get('child_id') or data.get('child')
        if child_pk:
            data['child_id'] = str(child_pk)

        centre_id = _child_centre_id(child_pk) if child_pk else None
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'children.view_info'):
            return permission_denied()

        enrolment = children_db.create_enrolment(data)

        child, slot, session, centre, room = _resolve_enrolment_context(enrolment)
        if child:
            send_enrolment_added_email(child, slot, session, centre, room=room)

        return Response(enrolment, status=status.HTTP_201_CREATED)

    def retrieve(self, request, *args, **kwargs):
        enrolment = children_db.get_enrolment(str(kwargs['pk']))
        if not enrolment:
            return Response({'detail': 'Enrolment not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = _child_centre_id(enrolment.get('child_id'))
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_view(centre_id, 'children.view_info'):
            return permission_denied()
        return Response(enrolment)

    def partial_update(self, request, *args, **kwargs):
        enrolment = children_db.get_enrolment(str(kwargs['pk']))
        if not enrolment:
            return Response({'detail': 'Enrolment not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = _child_centre_id(enrolment.get('child_id'))
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'children.view_info'):
            return permission_denied()

        new_slot_id = request.data.get('slot_id') or request.data.get('slot')
        old_slot_id = enrolment.get('slot_id') or enrolment.get('slot')
        slot_changed = bool(new_slot_id) and str(new_slot_id) != str(old_slot_id)

        updated = children_db.update_enrolment(str(kwargs['pk']), request.data)

        if slot_changed:
            child, slot, session, centre, room = _resolve_enrolment_context(updated)
            if child:
                send_enrolment_removed_email(child, slot, session, centre, reason='rescheduled', room=room)

        return Response(updated)

    def destroy(self, request, *args, **kwargs):
        enrolment = children_db.get_enrolment(str(kwargs['pk']))
        if not enrolment:
            return Response({'detail': 'Enrolment not found.'}, status=status.HTTP_404_NOT_FOUND)

        centre_id = _child_centre_id(enrolment.get('child_id'))
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'children.view_info'):
            return permission_denied()

        child, slot, session, centre, room = _resolve_enrolment_context(enrolment)

        children_db.delete_enrolment(str(kwargs['pk']))

        if child:
            send_enrolment_removed_email(child, slot, session, centre, reason='removed', room=room)

        return Response(status=status.HTTP_204_NO_CONTENT)
