"""
API tests for the progress app (journey entries, notes, attendance, course progress,
activity feed, and stats).

Same approach as the other apps' test suites: SimpleTestCase (settings.DATABASES is a
dummy backend), dynamo_backend.services and billing.notifications senders mocked at the
point they're imported into progress.views, and force_authenticate() instead of real JWTs.
"""
from unittest.mock import patch

from django.test import SimpleTestCase
from rest_framework import status
from rest_framework.test import APIClient

from roles.access import UserAccess

CHILD_ID = "11111111-1111-1111-1111-111111111111"
CENTRE_ID = "22222222-2222-2222-2222-222222222222"
ENTRY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
NOTE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
ATTENDANCE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
USER_ID = "55555555-5555-5555-5555-555555555555"


class FakeUser:
    def __init__(self, user_id=USER_ID, status="approved", role="staff"):
        self.id = user_id
        self.pk = user_id
        self.is_authenticated = True
        self.is_anonymous = False
        self.status = status
        self.role = role


class ProgressAPITestCase(SimpleTestCase):
    """Grants the acting user unrestricted access by default (root-equivalent
    UserAccess), so these tests exercise business logic rather than the
    permission matrix — see roles/test_access.py for that. Tests that need to
    assert enforcement itself override self.mock_get_user_access.return_value.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = FakeUser()
        self.client.force_authenticate(user=self.user)

        access_patcher = patch('progress.views.get_user_access')
        self.mock_get_user_access = access_patcher.start()
        self.mock_get_user_access.return_value = UserAccess(unrestricted=True)
        self.addCleanup(access_patcher.stop)


# =============================================================================
# Permissions
# =============================================================================

class ProgressPermissionsTests(SimpleTestCase):
    ENDPOINTS = [
        ("get", f"/api/v1/children/{CHILD_ID}/journey/"),
        ("get", f"/api/v1/children/{CHILD_ID}/notes/"),
        ("get", f"/api/v1/children/{CHILD_ID}/attendance/"),
        ("get", f"/api/v1/children/{CHILD_ID}/course-progress/"),
        ("get", f"/api/v1/children/{CHILD_ID}/activity/"),
        ("get", f"/api/v1/children/{CHILD_ID}/stats/"),
    ]

    def test_unauthenticated_requests_are_rejected(self):
        client = APIClient()
        for method, url in self.ENDPOINTS:
            with self.subTest(method=method, url=url):
                resp = getattr(client, method)(url)
                self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_unapproved_user_requests_are_forbidden(self):
        client = APIClient()
        client.force_authenticate(user=FakeUser(status="pending"))
        for method, url in self.ENDPOINTS:
            with self.subTest(method=method, url=url):
                resp = getattr(client, method)(url)
                self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


# =============================================================================
# JourneyEntryViewSet
# =============================================================================

@patch('progress.views.send_milestone_notification')
@patch('progress.views.centres_db')
@patch('progress.views.children_db')
@patch('progress.views.progress_db')
class JourneyEntryViewSetTests(ProgressAPITestCase):
    def test_list_journey_entries(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.list_journey.return_value = [{"id": ENTRY_ID, "child_id": CHILD_ID}]

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/journey/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_progress_db.list_journey.assert_called_once_with(CHILD_ID)

    def test_create_defaults_date_to_today(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.create_journey_entry.return_value = {"id": ENTRY_ID}
        mock_children_db.get_child.return_value = None

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/journey/',
            {"type": "Milestone", "text": "First steps", "staffName": "Teacher A"},
            format='json',
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent_data = mock_progress_db.create_journey_entry.call_args[0][1]
        self.assertIn("date", sent_data)

    def test_create_uses_provided_date(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.create_journey_entry.return_value = {"id": ENTRY_ID}
        mock_children_db.get_child.return_value = None

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/journey/',
            {"type": "Milestone", "text": "First steps", "staffName": "Teacher A", "date": "2026-01-01"},
            format='json',
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent_data = mock_progress_db.create_journey_entry.call_args[0][1]
        self.assertEqual(sent_data["date"], "2026-01-01")

    def test_create_sends_milestone_notification_when_child_found(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify
    ):
        mock_progress_db.create_journey_entry.return_value = {"id": ENTRY_ID}
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Centre A"}

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/journey/',
            {"type": "Milestone", "text": "First steps", "staffName": "Teacher A"},
            format='json',
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_notify.assert_called_once()
        notified_child = mock_notify.call_args[0][1]
        self.assertEqual(notified_child["centre_name"], "Centre A")

    def test_create_skips_notification_when_child_not_found(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify
    ):
        mock_progress_db.create_journey_entry.return_value = {"id": ENTRY_ID}
        mock_children_db.get_child.return_value = None

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/journey/',
            {"type": "Milestone", "text": "First steps", "staffName": "Teacher A"},
            format='json',
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_notify.assert_not_called()

    def test_retrieve_not_found(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.get_journey_entry.return_value = None

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/journey/{ENTRY_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_found(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.get_journey_entry.return_value = {"id": ENTRY_ID}

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/journey/{ENTRY_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_partial_update_not_found(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.get_journey_entry.return_value = None

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/journey/{ENTRY_ID}/', {"text": "Edited"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_progress_db.update_journey_entry.assert_not_called()

    def test_partial_update_success(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.get_journey_entry.return_value = {"id": ENTRY_ID}
        mock_progress_db.update_journey_entry.return_value = {"id": ENTRY_ID, "text": "Edited"}

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/journey/{ENTRY_ID}/', {"text": "Edited"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_progress_db.update_journey_entry.assert_called_once_with(ENTRY_ID, {"text": "Edited"})

    def test_destroy_not_found(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.get_journey_entry.return_value = None

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/journey/{ENTRY_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_progress_db.delete_journey_entry.assert_not_called()

    def test_destroy_success(self, mock_progress_db, mock_children_db, mock_centres_db, mock_notify):
        mock_progress_db.get_journey_entry.return_value = {"id": ENTRY_ID}

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/journey/{ENTRY_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_progress_db.delete_journey_entry.assert_called_once_with(ENTRY_ID)


# =============================================================================
# ChildNoteViewSet
# =============================================================================

@patch('progress.views.progress_db')
class ChildNoteViewSetTests(ProgressAPITestCase):
    def test_list_notes(self, mock_progress_db):
        mock_progress_db.list_notes.return_value = [{"id": NOTE_ID, "child_id": CHILD_ID}]

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/notes/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_progress_db.list_notes.assert_called_once_with(CHILD_ID)

    def test_create_defaults_date_to_today(self, mock_progress_db):
        mock_progress_db.create_note.return_value = {"id": NOTE_ID}

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/notes/', {"text": "Ate well", "staffName": "Teacher A"}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent_data = mock_progress_db.create_note.call_args[0][1]
        self.assertIn("date", sent_data)

    def test_retrieve_not_found(self, mock_progress_db):
        mock_progress_db.get_note.return_value = None

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/notes/{NOTE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_found(self, mock_progress_db):
        mock_progress_db.get_note.return_value = {"id": NOTE_ID}

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/notes/{NOTE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_partial_update_not_found(self, mock_progress_db):
        mock_progress_db.get_note.return_value = None

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/notes/{NOTE_ID}/', {"text": "Edited"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_partial_update_success(self, mock_progress_db):
        mock_progress_db.get_note.return_value = {"id": NOTE_ID}
        mock_progress_db.update_note.return_value = {"id": NOTE_ID, "text": "Edited"}

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/notes/{NOTE_ID}/', {"text": "Edited"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_progress_db.update_note.assert_called_once_with(NOTE_ID, {"text": "Edited"})

    def test_destroy_not_found(self, mock_progress_db):
        mock_progress_db.get_note.return_value = None

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/notes/{NOTE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_destroy_success(self, mock_progress_db):
        mock_progress_db.get_note.return_value = {"id": NOTE_ID}

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/notes/{NOTE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_progress_db.delete_note.assert_called_once_with(NOTE_ID)


# =============================================================================
# AttendanceViewSet
# =============================================================================

@patch('progress.views.send_attendance_notification')
@patch('progress.views.auth_db')
@patch('progress.views.sessions_db')
@patch('progress.views.centres_db')
@patch('progress.views.children_db')
@patch('progress.views.progress_db')
class AttendanceViewSetTests(ProgressAPITestCase):
    def test_list_without_child_returns_empty(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        resp = self.client.get('/api/v1/attendances/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [])
        mock_progress_db.list_attendance.assert_not_called()

    def test_list_via_query_param_on_standalone_route(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.list_attendance.return_value = [{"id": ATTENDANCE_ID}]

        resp = self.client.get(f'/api/v1/attendances/?child={CHILD_ID}')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_progress_db.list_attendance.assert_called_once_with(CHILD_ID, None, None)

    def test_list_nested_with_date_range(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.list_attendance.return_value = []

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/attendance/?date_from=2026-01-01&date_to=2026-01-31')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_progress_db.list_attendance.assert_called_once_with(CHILD_ID, "2026-01-01", "2026-01-31")

    def test_create_without_child_is_rejected(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        resp = self.client.post('/api/v1/attendances/', {"status": "attended"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_progress_db.create_attendance.assert_not_called()

    def test_create_rejects_duplicate_slot_on_same_date(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.list_attendance.return_value = [
            {"date": "2026-01-01", "slot_id": "slot-1"}
        ]

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/attendance/',
            {"date": "2026-01-01", "slotId": "slot-1"},
            format='json',
        )

        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        mock_progress_db.create_attendance.assert_not_called()

    def test_create_rejects_duplicate_session_on_same_date_when_no_slot(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.list_attendance.return_value = [
            {"date": "2026-01-01", "session_id": "session-1"}
        ]

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/attendance/',
            {"date": "2026-01-01", "sessionId": "session-1"},
            format='json',
        )

        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        mock_progress_db.create_attendance.assert_not_called()

    def test_create_allows_same_date_different_slot(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.list_attendance.return_value = [
            {"date": "2026-01-01", "slot_id": "other-slot"}
        ]
        mock_progress_db.create_attendance.return_value = {"id": ATTENDANCE_ID}
        mock_children_db.get_child.return_value = None

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/attendance/',
            {"date": "2026-01-01", "slotId": "slot-1"},
            format='json',
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_create_defaults_date_to_today(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.list_attendance.return_value = []
        mock_progress_db.create_attendance.return_value = {"id": ATTENDANCE_ID}
        mock_children_db.get_child.return_value = None

        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/attendance/', {"status": "attended"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent_data = mock_progress_db.create_attendance.call_args[0][1]
        self.assertIn("date", sent_data)

    def test_create_sends_notification_with_resolved_teacher_name(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.list_attendance.return_value = []
        mock_progress_db.create_attendance.return_value = {"id": ATTENDANCE_ID}
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID, "centre_name": "Centre A"}
        mock_sessions_db.get_session.return_value = {"id": "session-1", "name": "Session A"}
        mock_auth_db.get_user_by_id.return_value = {"first_name": "Jane", "last_name": "Doe"}

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/attendance/',
            {"status": "attended", "sessionId": "session-1", "teacherId": "teacher-1"},
            format='json',
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_notify.assert_called_once()
        _, kwargs = mock_notify.call_args
        self.assertEqual(kwargs["teacher_name"], "Jane Doe")

    def test_create_notification_teacher_name_falls_back_to_unknown(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.list_attendance.return_value = []
        mock_progress_db.create_attendance.return_value = {"id": ATTENDANCE_ID}
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID, "centre_name": "Centre A"}

        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/attendance/', {"status": "attended"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        _, kwargs = mock_notify.call_args
        self.assertEqual(kwargs["teacher_name"], "Unknown")

    def test_retrieve_not_found(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.get_attendance.return_value = None

        resp = self.client.get(f'/api/v1/attendances/{ATTENDANCE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_partial_update_success(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.get_attendance.return_value = {"id": ATTENDANCE_ID}
        mock_progress_db.update_attendance.return_value = {"id": ATTENDANCE_ID, "status": "absent"}

        resp = self.client.patch(f'/api/v1/attendances/{ATTENDANCE_ID}/', {"status": "absent"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_progress_db.update_attendance.assert_called_once_with(ATTENDANCE_ID, {"status": "absent"})

    def test_destroy_success(
        self, mock_progress_db, mock_children_db, mock_centres_db, mock_sessions_db, mock_auth_db, mock_notify
    ):
        mock_progress_db.get_attendance.return_value = {"id": ATTENDANCE_ID}

        resp = self.client.delete(f'/api/v1/attendances/{ATTENDANCE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_progress_db.delete_attendance.assert_called_once_with(ATTENDANCE_ID)


# =============================================================================
# CourseProgressViewSet
# =============================================================================

@patch('progress.views.progress_db')
class CourseProgressViewSetTests(ProgressAPITestCase):
    def test_list_without_child_returns_empty(self, mock_progress_db):
        resp = self.client.get('/api/v1/course-progress/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [])
        mock_progress_db.get_course_progress.assert_not_called()

    def test_list_via_query_param(self, mock_progress_db):
        mock_progress_db.get_course_progress.return_value = {"child_id": CHILD_ID, "current_month": 2}

        resp = self.client.get(f'/api/v1/course-progress/?child={CHILD_ID}')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [{"child_id": CHILD_ID, "current_month": 2}])

    def test_list_nested_with_no_existing_progress_returns_empty_list(self, mock_progress_db):
        mock_progress_db.get_course_progress.return_value = None

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/course-progress/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [])

    def test_create_without_child_is_rejected(self, mock_progress_db):
        resp = self.client.post('/api/v1/course-progress/', {"currentMonth": 2}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_progress_db.set_course_progress.assert_not_called()

    def test_create_new_progress_returns_201(self, mock_progress_db):
        mock_progress_db.get_course_progress.return_value = None
        mock_progress_db.set_course_progress.return_value = {"child_id": CHILD_ID, "current_month": 1}

        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/course-progress/', {"currentMonth": 1}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_create_upserts_existing_progress_returns_200(self, mock_progress_db):
        mock_progress_db.get_course_progress.return_value = {"child_id": CHILD_ID, "current_month": 1}
        mock_progress_db.set_course_progress.return_value = {"child_id": CHILD_ID, "current_month": 2}

        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/course-progress/', {"currentMonth": 2}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_retrieve_without_child_scope_is_404(self, mock_progress_db):
        # Standalone route (no child_pk in kwargs) — retrieve() itself returns 404
        # by design since course progress is keyed by child_id, not a standalone id.
        resp = self.client.get(f'/api/v1/course-progress/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_progress_db.get_course_progress.assert_not_called()

    def test_partial_update_without_child_scope_is_404(self, mock_progress_db):
        resp = self.client.patch(f'/api/v1/course-progress/{CHILD_ID}/', {"currentMonth": 3}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_progress_db.set_course_progress.assert_not_called()

    def test_create_rejects_month_out_of_range(self, mock_progress_db):
        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/course-progress/', {"currentMonth": 99}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_progress_db.set_course_progress.assert_not_called()

    def test_create_drops_unknown_fields(self, mock_progress_db):
        mock_progress_db.get_course_progress.return_value = None
        mock_progress_db.set_course_progress.return_value = {"child_id": CHILD_ID}

        self.client.post(
            f'/api/v1/children/{CHILD_ID}/course-progress/',
            {"currentMonth": 2, "currentWeek": 3, "isAdmin": True},
            format='json',
        )

        mock_progress_db.set_course_progress.assert_called_once_with(
            CHILD_ID, {"current_month": 2, "current_week": 3}
        )

    def test_nested_partial_update_rejects_week_out_of_range(self, mock_progress_db):
        resp = self.client.patch(
            f'/api/v1/children/{CHILD_ID}/course-progress/{CHILD_ID}/', {"currentWeek": 5}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_progress_db.set_course_progress.assert_not_called()

    def test_nested_partial_update_does_not_default_other_field(self, mock_progress_db):
        mock_progress_db.set_course_progress.return_value = {"child_id": CHILD_ID}

        self.client.patch(
            f'/api/v1/children/{CHILD_ID}/course-progress/{CHILD_ID}/', {"currentWeek": 3}, format='json'
        )

        mock_progress_db.set_course_progress.assert_called_once_with(CHILD_ID, {"current_week": 3})


class CourseProgressServiceTests(SimpleTestCase):
    def setUp(self):
        from dynamo_backend.services.progress_service import ProgressDynamoService
        with patch('dynamo_backend.services.progress_service.DynamoDBService'):
            self.service = ProgressDynamoService()
        self.table = self.service.course_progress

    def test_set_writes_display_merged_with_existing_values(self):
        self.table.get.return_value = {"child_id": CHILD_ID, "current_month": 4, "current_week": 2}

        self.service.set_course_progress(CHILD_ID, {"current_week": 3})

        self.table.update.assert_called_once_with(
            CHILD_ID, {"current_week": 3, "display": "M4 W3"}, key_name='child_id'
        )

    def test_delete_uses_child_id_key(self):
        self.service.delete_course_progress(CHILD_ID)

        self.table.delete.assert_called_once_with(CHILD_ID, key_name='child_id')


@patch('progress.views.progress_db')
class CourseProgressNestedDetailRouteTests(ProgressAPITestCase):
    """
    progress/urls.py registers

        children/<child_pk>/course-progress/<pk>/ -> {'get': 'retrieve', 'patch': 'partial_update'}

    with no 'delete' entry, since course progress is upsert-only by design and
    CourseProgressViewSet doesn't implement destroy() (see PR #15 review). DELETE on
    this nested URL correctly 405s, while GET/PATCH work as expected.
    """

    def test_get_returns_progress(self, mock_progress_db):
        mock_progress_db.get_course_progress.return_value = {"child_id": CHILD_ID, "current_month": 2}

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/course-progress/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_patch_updates_progress(self, mock_progress_db):
        mock_progress_db.set_course_progress.return_value = {"child_id": CHILD_ID, "current_month": 3}

        resp = self.client.patch(
            f'/api/v1/children/{CHILD_ID}/course-progress/{CHILD_ID}/', {"currentMonth": 3}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_delete_is_not_allowed(self, mock_progress_db):
        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/course-progress/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)


# =============================================================================
# child_activity_feed
# =============================================================================

@patch('progress.views.progress_db')
@patch('progress.views.children_db')
class ChildActivityFeedTests(ProgressAPITestCase):
    def test_child_not_found(self, mock_children_db, mock_progress_db):
        mock_children_db.get_child.return_value = None

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/activity/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_includes_registration_event_sorted_with_activities(self, mock_children_db, mock_progress_db):
        mock_children_db.get_child.return_value = {
            "id": CHILD_ID, "start_date": "2026-01-01", "centre_name": "Centre A", "created_at": "2026-01-01T00:00:00",
        }
        mock_progress_db.get_activity_feed.return_value = [
            {"type": "attendance", "date": "2026-02-01", "text": "Attended"},
        ]

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/activity/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        types = [a["type"] for a in resp.data]
        self.assertIn("registration", types)
        # Newest first
        self.assertEqual(resp.data[0]["type"], "attendance")


# =============================================================================
# child_stats
# =============================================================================

@patch('progress.views.progress_db')
@patch('progress.views.children_db')
class ChildStatsTests(ProgressAPITestCase):
    def test_child_not_found(self, mock_children_db, mock_progress_db):
        mock_children_db.get_child.return_value = None

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/stats/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_returns_stats_for_child(self, mock_children_db, mock_progress_db):
        mock_children_db.get_child.return_value = {"id": CHILD_ID}
        mock_progress_db.get_child_stats.return_value = {
            "sessions_this_week": 2, "total_sessions": 10, "journey_entries": 3, "course_progress": "M2 W1",
        }

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/stats/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["total_sessions"], 10)


# =============================================================================
# Permission-matrix enforcement (dynamic role-based access — see roles/access.py)
# =============================================================================

@patch('progress.views.children_db')
@patch('progress.views.progress_db')
class ProgressEnforcementTests(ProgressAPITestCase):
    """Unlike the rest of this file, these tests give the acting user a
    restricted (non-root) UserAccess to verify the enforcement itself,
    rather than the business logic downstream of it. Progress records are
    only centre-scoped (no per-key view/edit matrix yet — see the plan).
    """

    def test_list_notes_returns_404_when_child_centre_is_not_accessible(self, mock_progress_db, mock_children_db):
        self.mock_get_user_access.return_value = UserAccess(unrestricted=False)
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/notes/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_progress_db.list_notes.assert_not_called()

    def test_list_notes_succeeds_for_a_member_of_the_childs_centre(self, mock_progress_db, mock_children_db):
        access = UserAccess(unrestricted=False)
        access.centres[CENTRE_ID] = {
            'data_scope': 'own', 'role_names': ['Teacher'], 'name': '', 'system_id': '', 'permissions': {},
        }
        self.mock_get_user_access.return_value = access
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}
        mock_progress_db.list_notes.return_value = []

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/notes/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_progress_db.list_notes.assert_called_once_with(CHILD_ID)
