from datetime import date, datetime

from rest_framework import viewsets, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from schindia_auth.permissions import IsApprovedUser
from dynamo_backend.services import progress_db, children_db, centres_db, sessions_db, auth_db
from billing.notifications import send_milestone_notification, send_attendance_notification
from roles.access import get_user_access, centre_not_found
from .serializers import (
    JourneyEntrySerializer,
    ChildNoteSerializer,
    AttendanceSerializer,
    CourseProgressSerializer,
)


def _child_centre_id(child_id):
    """Resolve the centre a child belongs to, for scope checks."""
    if not child_id:
        return None
    child = children_db.get_child(str(child_id))
    return child.get('centre_id') if child else None


def _require_child_centre_access(request, child_id, not_found_detail='Not found.'):
    """Scope check reused by every progress endpoint below: the acting user
    must belong to the centre the given child belongs to. Returns a 404
    Response if not, else None.
    """
    access = get_user_access(request.user, request)
    if not access.can_access_centre(_child_centre_id(child_id)):
        return centre_not_found(not_found_detail)
    return None


class JourneyEntryViewSet(viewsets.ViewSet):
    serializer_class = JourneyEntrySerializer
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response([])
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp
        entries = progress_db.list_journey(str(child_pk))
        return Response(entries)

    def create(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response({'detail': 'A child is required to create a journey entry.'}, status=status.HTTP_400_BAD_REQUEST)
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp

        data = request.data.copy()
        data['date'] = data.get('date') or date.today().isoformat()
        entry = progress_db.create_journey_entry(str(child_pk), data)

        child = children_db.get_child(str(child_pk))
        if child:
            if not child.get('centre_name') and child.get('centre_id'):
                centre = centres_db.get_centre(str(child['centre_id']))
                child['centre_name'] = centre.get('name', '') if centre else ''
            send_milestone_notification(entry, child)

        return Response(entry, status=status.HTTP_201_CREATED)

    def retrieve(self, request, *args, **kwargs):
        entry = progress_db.get_journey_entry(str(kwargs['pk']))
        if not entry:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, entry.get('child_id'))
        if resp:
            return resp
        return Response(entry)

    def partial_update(self, request, *args, **kwargs):
        entry = progress_db.get_journey_entry(str(kwargs['pk']))
        if not entry:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, entry.get('child_id'))
        if resp:
            return resp
        updated = progress_db.update_journey_entry(str(kwargs['pk']), request.data)
        return Response(updated)

    def destroy(self, request, *args, **kwargs):
        entry = progress_db.get_journey_entry(str(kwargs['pk']))
        if not entry:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, entry.get('child_id'))
        if resp:
            return resp
        progress_db.delete_journey_entry(str(kwargs['pk']))
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChildNoteViewSet(viewsets.ViewSet):
    serializer_class = ChildNoteSerializer
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response([])
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp
        notes = progress_db.list_notes(str(child_pk))
        return Response(notes)

    def create(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response({'detail': 'A child is required to create a note.'}, status=status.HTTP_400_BAD_REQUEST)
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp

        data = request.data.copy()
        data['date'] = data.get('date') or date.today().isoformat()
        note = progress_db.create_note(str(child_pk), data)
        return Response(note, status=status.HTTP_201_CREATED)

    def retrieve(self, request, *args, **kwargs):
        note = progress_db.get_note(str(kwargs['pk']))
        if not note:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, note.get('child_id'))
        if resp:
            return resp
        return Response(note)

    def partial_update(self, request, *args, **kwargs):
        note = progress_db.get_note(str(kwargs['pk']))
        if not note:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, note.get('child_id'))
        if resp:
            return resp
        updated = progress_db.update_note(str(kwargs['pk']), request.data)
        return Response(updated)

    def destroy(self, request, *args, **kwargs):
        note = progress_db.get_note(str(kwargs['pk']))
        if not note:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, note.get('child_id'))
        if resp:
            return resp
        progress_db.delete_note(str(kwargs['pk']))
        return Response(status=status.HTTP_204_NO_CONTENT)


class AttendanceViewSet(viewsets.ViewSet):
    serializer_class = AttendanceSerializer
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        # Resolve child_pk from URL or query param
        cid = child_pk or request.query_params.get('child')
        if not cid:
            return Response([])
        resp = _require_child_centre_access(request, cid)
        if resp:
            return resp
        date_from = request.query_params.get('date_from')
        date_to = request.query_params.get('date_to')
        records = progress_db.list_attendance(str(cid), date_from, date_to)
        return Response(records)

    def create(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response({'detail': 'A child is required to record attendance.'}, status=status.HTTP_400_BAD_REQUEST)
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp

        data = request.data.copy()
        data['date'] = data.get('date') or date.today().isoformat()

        # Duplicate guard: prevent same child + same date + same slot/session
        slot_id = data.get('slot_id') or data.get('slot')
        session_id = data.get('session_id') or data.get('session')
        existing = progress_db.list_attendance(str(child_pk))
        for rec in existing:
            if rec.get('date') != data['date']:
                continue
            if slot_id and rec.get('slot_id') == str(slot_id):
                return Response(
                    {'detail': 'Attendance already recorded for this child on this date and slot.'},
                    status=status.HTTP_409_CONFLICT
                )
            if not slot_id and session_id and rec.get('session_id') == str(session_id):
                return Response(
                    {'detail': 'Attendance already recorded for this child on this date and session.'},
                    status=status.HTTP_409_CONFLICT
                )

        data['marked_by_id'] = str(request.user.id)
        full_name = request.user.get_full_name() if hasattr(request.user, 'get_full_name') else f"{getattr(request.user, 'first_name', '')} {getattr(request.user, 'last_name', '')}".strip()
        data['marked_by_name'] = full_name or getattr(request.user, 'email', 'staff')
        data['marked_at'] = datetime.utcnow().isoformat()

        record = progress_db.create_attendance(str(child_pk), data)

        child = children_db.get_child(str(child_pk))
        if child:
            if not child.get('centre_name') and child.get('centre_id'):
                centre = centres_db.get_centre(str(child['centre_id']))
                child['centre_name'] = centre.get('name', '') if centre else ''

            session = sessions_db.get_session(str(session_id), centre_id=child.get('centre_id')) if session_id else None

            teacher_id = data.get('teacher_id') or data.get('teacher')
            teacher_name = None
            if teacher_id:
                teacher_user = auth_db.get_user_by_id(str(teacher_id))
                if teacher_user:
                    teacher_name = f"{teacher_user.get('first_name', '')} {teacher_user.get('last_name', '')}".strip()
            if not teacher_name:
                teacher_name = "Unknown"

            send_attendance_notification(record, child, session=session, teacher_name=teacher_name)

        return Response(record, status=status.HTTP_201_CREATED)

    def retrieve(self, request, *args, **kwargs):
        record = progress_db.get_attendance(str(kwargs['pk']))
        if not record:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, record.get('child_id'))
        if resp:
            return resp
        return Response(record)

    def partial_update(self, request, *args, **kwargs):
        record = progress_db.get_attendance(str(kwargs['pk']))
        if not record:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, record.get('child_id'))
        if resp:
            return resp
        updated = progress_db.update_attendance(str(kwargs['pk']), request.data)
        return Response(updated)

    def destroy(self, request, *args, **kwargs):
        record = progress_db.get_attendance(str(kwargs['pk']))
        if not record:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, record.get('child_id'))
        if resp:
            return resp
        progress_db.delete_attendance(str(kwargs['pk']))
        return Response(status=status.HTTP_204_NO_CONTENT)


class CourseProgressViewSet(viewsets.ViewSet):
    serializer_class = CourseProgressSerializer
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk') or request.query_params.get('child')
        if not child_pk:
            return Response([])
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp
        progress = progress_db.get_course_progress(str(child_pk))
        return Response([progress] if progress else [])

    def create(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response({'detail': 'A child is required to set course progress.'}, status=status.HTTP_400_BAD_REQUEST)
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp

        data = request.data.copy()
        # Check if progress already exists (upsert semantics)
        existing = progress_db.get_course_progress(str(child_pk))
        progress = progress_db.set_course_progress(str(child_pk), data)
        if existing:
            return Response(progress, status=status.HTTP_200_OK)
        return Response(progress, status=status.HTTP_201_CREATED)

    def retrieve(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            # Course progress is keyed by child_id in DynamoDB — a standalone
            # lookup by an arbitrary id isn't supported.
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp
        progress = progress_db.get_course_progress(str(child_pk))
        if not progress:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(progress)

    def partial_update(self, request, *args, **kwargs):
        child_pk = self.kwargs.get('child_pk')
        if not child_pk:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        resp = _require_child_centre_access(request, child_pk)
        if resp:
            return resp
        progress = progress_db.set_course_progress(str(child_pk), request.data)
        return Response(progress)


@api_view(['GET'])
@permission_classes([IsAuthenticated, IsApprovedUser])
def child_activity_feed(request, child_pk):
    """Unified activity timeline for a child (Req 13.5)."""
    child = children_db.get_child(str(child_pk))
    if not child:
        return Response({'detail': 'Child not found.'}, status=status.HTTP_404_NOT_FOUND)
    resp = _require_child_centre_access(request, child_pk, 'Child not found.')
    if resp:
        return resp

    activities = progress_db.get_activity_feed(str(child_pk), limit=20)

    # Add registration event
    reg_date = child.get('start_date') or child.get('created_at', '')[:10]
    centre_name = child.get('centre_name', 'centre')
    activities.append({
        'type': 'registration',
        'date': reg_date,
        'text': f"Joined {centre_name}",
        'created_at': child.get('created_at', ''),
    })

    # If child has an assigned session and not already logged
    if child.get('session_id'):
        has_enrolment = any(a.get('type') == 'enrolment' for a in activities)
        if not has_enrolment:
            sess = sessions_db.get_session(str(child['session_id']), centre_id=child.get('centre_id'))
            sess_name = sess.get('name') if sess else 'session'
            activities.append({
                'type': 'enrolment',
                'date': reg_date,
                'text': f"Enrolled in {sess_name}",
                'created_at': child.get('created_at', ''),
            })

    activities.sort(key=lambda x: x.get('date') or '', reverse=True)
    return Response(activities)


@api_view(['GET'])
@permission_classes([IsAuthenticated, IsApprovedUser])
def child_stats(request, child_pk):
    """Summary stats for a child (Req 13.4)."""
    child = children_db.get_child(str(child_pk))
    if not child:
        return Response({'detail': 'Child not found.'}, status=status.HTTP_404_NOT_FOUND)
    resp = _require_child_centre_access(request, child_pk, 'Child not found.')
    if resp:
        return resp
    stats = progress_db.get_child_stats(str(child_pk))
    return Response(stats)
