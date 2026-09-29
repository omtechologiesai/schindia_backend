"""Sessions: a fixed catalogue, with one row per centre per catalogue session.

The 6 sessions (Chick..Giraffe) are defined here — their name, age range and
colour cannot be changed. Each centre gets its own row for each of them in the
Sessions table, created when the centre is created: a UUID ``id`` (the only
uniqueness the table enforces), the ``slug`` linking it to the catalogue, a
readable ``session_key`` of ``{centre_id}#{slug}``, and that centre's
child_limit and duration.

Slots reference a session by its row id, which already identifies the centre.
"""

import logging
import uuid
from datetime import timedelta, datetime
from ..service import DynamoDBService
from ..tables import SESSIONS_TABLE, SESSION_SLOTS_TABLE

logger = logging.getLogger(__name__)

DAY_MAP = {0: 'mon', 1: 'tue', 2: 'wed', 3: 'thu', 4: 'fri', 5: 'sat', 6: 'sun'}

STATIC_SESSIONS = [
    {'slug': 'chick',   'name': 'Chick',   'age_from': 6, 'age_to': 18, 'age_unit': 'months',
     'color_bg': '#fef3c7', 'color_text': '#92400e'},
    {'slug': 'bunny',   'name': 'Bunny',   'age_from': 2, 'age_to': 2,  'age_unit': 'years',
     'color_bg': '#fce7f3', 'color_text': '#be185d'},
    {'slug': 'kitty',   'name': 'Kitty',   'age_from': 3, 'age_to': 3,  'age_unit': 'years',
     'color_bg': '#e0f2fe', 'color_text': '#0369a1'},
    {'slug': 'puppy',   'name': 'Puppy',   'age_from': 4, 'age_to': 4,  'age_unit': 'years',
     'color_bg': '#dcfce7', 'color_text': '#166534'},
    {'slug': 'bear',    'name': 'Bear',    'age_from': 5, 'age_to': 5,  'age_unit': 'years',
     'color_bg': '#ede9fe', 'color_text': '#5b21b6'},
    {'slug': 'giraffe', 'name': 'Giraffe', 'age_from': 6, 'age_to': 6,  'age_unit': 'years',
     'color_bg': '#ecfeff', 'color_text': '#155e75'},
]

_STATIC_BY_SLUG = {s['slug']: s for s in STATIC_SESSIONS}

DEFAULT_CHILD_LIMIT = 8
DEFAULT_DURATION_HOURS = 1
DEFAULT_DURATION_MINUTES = 30


class SessionsDynamoService:
    def __init__(self):
        self.sessions = DynamoDBService(SESSIONS_TABLE)
        self.slots = DynamoDBService(SESSION_SLOTS_TABLE)

    # ── Sessions (catalogue + one row per centre) ──────────────────────

    def provision_centre_sessions(self, centre_id):
        """Create a row for each catalogue session this centre doesn't have yet. Safe to re-run."""
        centre_id = str(centre_id)
        existing = {r.get('slug') for r in self._centre_rows(centre_id)}
        for static in STATIC_SESSIONS:
            if static['slug'] in existing:
                continue
            self.sessions.create({
                'id': str(uuid.uuid4()),
                'centre_id': centre_id,
                'slug': static['slug'],
                'session_key': f"{centre_id}#{static['slug']}",
                'child_limit': DEFAULT_CHILD_LIMIT,
                'duration_hours': DEFAULT_DURATION_HOURS,
                'duration_minutes': DEFAULT_DURATION_MINUTES,
            })

    def list_sessions(self, centre_id):
        """This centre's sessions, in catalogue order."""
        by_slug = {r['slug']: r for r in self._centre_rows(str(centre_id))}
        return [self._build(by_slug[s['slug']]) for s in STATIC_SESSIONS if s['slug'] in by_slug]

    def get_session(self, session_id, centre_id):
        """Look up a session by its id. When centre_id is given, the session must belong to it."""
        row = self.sessions.get(str(session_id))
        if not self._is_session_row(row):
            return None
        if centre_id and row.get('centre_id') != str(centre_id):
            return None
        return self._build(row)

    def update_session(self, centre_id, session_id, updates):
        """Update a centre's session. Only child_limit and duration are writable."""
        session_id = str(session_id)
        row = self.sessions.get(session_id)
        if not self._is_session_row(row) or row.get('centre_id') != str(centre_id):
            logger.warning(f"Attempted to update non-existent session: {session_id}")
            return None
        allowed = {
            k: updates[k]
            for k in ('child_limit', 'duration_hours', 'duration_minutes')
            if k in updates
        }
        if allowed:
            row = self.sessions.update(session_id, allowed)
        return self._build(row)

    def delete_centre_sessions(self, centre_id):
        for row in self.sessions.query_by_index('centre_id-index', 'centre_id', str(centre_id)):
            self.sessions.delete(row['id'])

    def _centre_rows(self, centre_id):
        rows = self.sessions.query_by_index('centre_id-index', 'centre_id', centre_id)
        return [r for r in rows if self._is_session_row(r)]

    @staticmethod
    def _is_session_row(row):
        # session_key marks rows made by provisioning; this skips override rows
        # left by the previous design and any slug no longer in the catalogue.
        return bool(row) and 'session_key' in row and row.get('slug') in _STATIC_BY_SLUG

    @staticmethod
    def _build(row):
        static = _STATIC_BY_SLUG[row['slug']]
        return {
            'id': row['id'],
            'centre_id': row.get('centre_id', ''),
            'slug': row['slug'],
            'name': static['name'],
            'age_from': static['age_from'],
            'age_to': static['age_to'],
            'age_unit': static['age_unit'],
            'color_bg': static['color_bg'],
            'color_text': static['color_text'],
            'child_limit': int(row.get('child_limit', DEFAULT_CHILD_LIMIT)),
            'duration_hours': int(row.get('duration_hours', DEFAULT_DURATION_HOURS)),
            'duration_minutes': int(row.get('duration_minutes', DEFAULT_DURATION_MINUTES)),
        }

    # ── Slots ──────────────────────────────────────────────────────────

    def create_slot(self, centre_id, data):
        data['id'] = str(uuid.uuid4())
        data['centre_id'] = str(centre_id)
        return self.slots.create(data)

    def get_slot(self, slot_id):
        return self.slots.get(str(slot_id))

    def list_slots(self, centre_id, week=None):
        slots = self.slots.query_by_index('centre_id-index', 'centre_id', str(centre_id))
        if week:
            try:
                week_start = datetime.strptime(week, '%Y-%m-%d').date()
                week_end = week_start + timedelta(days=6)
                slots = [
                    s for s in slots
                    if s.get('start_date') and
                    week_start <= datetime.strptime(s['start_date'], '%Y-%m-%d').date() <= week_end
                ]
            except (ValueError, TypeError):
                pass
        return slots

    def list_slots_by_room(self, room_id):
        return self.slots.query_by_index('room_id-index', 'room_id', str(room_id))

    def update_slot(self, slot_id, updates):
        return self.slots.update(str(slot_id), updates)

    def delete_slot(self, slot_id):
        return self.slots.delete(str(slot_id))

    # ── Timetable generation ───────────────────────────────────────────

    def generate_slots(self, centre_id, data):
        """Generate recurring slots (up to 15) or one-off."""
        session = self.get_session(data['session_id'], centre_id=centre_id)
        if not session:
            return None, "Session not found."

        duration_minutes = session['duration_hours'] * 60 + session['duration_minutes']
        start_date = datetime.strptime(data['start_date'], '%Y-%m-%d').date()
        start_time = data['start_time']

        time_parts = start_time.split(':')
        start_minutes = int(time_parts[0]) * 60 + int(time_parts[1])

        num_slots = 1 if data.get('booking_type') == 'one-off' else 15

        conflicts = []
        slot_dates = []
        for i in range(num_slots):
            slot_date = start_date + timedelta(weeks=i)
            slot_dates.append(slot_date)
            if self._has_overlap(centre_id, data['room_id'], slot_date, start_minutes, duration_minutes):
                conflicts.append(str(slot_date))

        if conflicts:
            return None, conflicts

        created = []
        starting_month = data.get('starting_month', 1)
        starting_week = data.get('starting_week', 1)

        for slot_date in slot_dates:
            day = DAY_MAP[slot_date.weekday()]
            slot = {
                'id': str(uuid.uuid4()),
                'centre_id': str(centre_id),
                'room_id': data['room_id'],
                'session_id': data['session_id'],
                'day': day,
                'start_time': start_time,
                'booking_type': data.get('booking_type', 'recurring'),
                'start_date': str(slot_date),
                'starting_month': starting_month,
                'starting_week': starting_week,
                'teacher_ids': data.get('teacher_ids', []),
                'child_ids': data.get('child_ids', []),
                'notes': data.get('notes', ''),
            }
            created.append(self.slots.create(slot))

            starting_week += 1
            if starting_week > 4:
                starting_week = 1
                starting_month += 1

        return created, None

    def _has_overlap(self, centre_id, room_id, date, start_minutes, duration_minutes):
        """Check for time overlaps in the same room on the same date."""
        existing = self.slots.query_by_index('centre_id-index', 'centre_id', str(centre_id))
        proposed_end = start_minutes + duration_minutes

        for slot in existing:
            if slot.get('room_id') != room_id:
                continue
            if slot.get('start_date') != str(date):
                continue

            slot_time = slot.get('start_time', '00:00').split(':')
            slot_start = int(slot_time[0]) * 60 + int(slot_time[1])

            session = self.get_session(slot.get('session_id'), centre_id=centre_id)
            slot_duration = (
                session['duration_hours'] * 60 + session['duration_minutes']
                if session else 90
            )
            slot_end = slot_start + slot_duration

            if start_minutes < slot_end and proposed_end > slot_start:
                return True

        return False
