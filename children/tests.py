"""
API tests for the children app.

Same approach as billing/tests.py and centres/tests.py: SimpleTestCase (settings.DATABASES
is a dummy backend, so no TestCase/transaction machinery), dynamo_backend.services mocked
at the point they're imported into children.views, and force_authenticate() with a
lightweight fake user instead of real JWTs.
"""
from unittest.mock import patch

from django.test import SimpleTestCase
from rest_framework import status
from rest_framework.test import APIClient

from roles.access import UserAccess

CENTRE_ID = "22222222-2222-2222-2222-222222222222"
CHILD_ID = "11111111-1111-1111-1111-111111111111"
CONTACT_ID = "88888888-8888-8888-8888-888888888888"
ENROLMENT_ID = "99999999-9999-9999-9999-999999999999"
USER_ID = "55555555-5555-5555-5555-555555555555"

VALID_CHILD_PAYLOAD = {
    "firstName": "Kid",
    "lastName": "One",
    "gender": "Male",
    "dateOfBirth": "2020-01-01",
    "startDate": "2023-01-01",
}

VALID_CONTACT_PAYLOAD = {
    "name": "Pat Parent",
    "relation": "Mother",
    "phone": "9876543210",
    "email": "pat@example.com",
}


class FakeUser:
    def __init__(self, user_id=USER_ID, status="approved", role="staff"):
        self.id = user_id
        self.pk = user_id
        self.is_authenticated = True
        self.is_anonymous = False
        self.status = status
        self.role = role


class ChildrenAPITestCase(SimpleTestCase):
    """Grants the acting user unrestricted access by default (root-equivalent
    UserAccess), so these tests exercise business logic rather than the
    permission matrix — see roles/test_access.py for that. Tests that need to
    assert enforcement itself override self.mock_get_user_access.return_value.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = FakeUser()
        self.client.force_authenticate(user=self.user)

        access_patcher = patch('children.views.get_user_access')
        self.mock_get_user_access = access_patcher.start()
        self.mock_get_user_access.return_value = UserAccess(unrestricted=True)
        self.addCleanup(access_patcher.stop)


# =============================================================================
# Permissions
# =============================================================================

class ChildrenPermissionsTests(SimpleTestCase):
    ENDPOINTS = [
        ("get", f"/api/v1/children/?centre={CENTRE_ID}"),
        ("get", f"/api/v1/children/{CHILD_ID}/"),
        ("post", "/api/v1/children/"),
        ("get", f"/api/v1/children/{CHILD_ID}/contacts/"),
        ("get", f"/api/v1/children/{CHILD_ID}/enrolments/"),
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
# ChildViewSet: list
# =============================================================================

@patch('children.views.children_db')
class ChildListTests(ChildrenAPITestCase):
    def test_list_without_centre_filter_is_rejected(self, mock_children_db):
        resp = self.client.get('/api/v1/children/')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("centre query parameter is required", resp.data["detail"])
        mock_children_db.list_children.assert_not_called()

    def test_list_with_centre_query_param(self, mock_children_db):
        mock_children_db.list_children.return_value = [{"id": CHILD_ID}]

        resp = self.client.get(f'/api/v1/children/?centre={CENTRE_ID}')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_children_db.list_children.assert_called_once_with(CENTRE_ID, archived=False)

    def test_list_nested_under_centre(self, mock_children_db):
        mock_children_db.list_children.return_value = [{"id": CHILD_ID}]

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/children/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_children_db.list_children.assert_called_once_with(CENTRE_ID, archived=False)


# =============================================================================
# ChildViewSet: retrieve
# =============================================================================

@patch('children.views.children_db')
class ChildRetrieveTests(ChildrenAPITestCase):
    def test_retrieve_not_found(self, mock_children_db):
        mock_children_db.get_child.return_value = None

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_found_without_centre_scope(self, mock_children_db):
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_retrieve_scoped_to_matching_centre(self, mock_children_db):
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/children/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_retrieve_scoped_to_mismatched_centre_is_404(self, mock_children_db):
        other_centre = "77777777-7777-7777-7777-777777777777"
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": other_centre}

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/children/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


# =============================================================================
# ChildViewSet: create
# =============================================================================

@patch('children.views.children_db')
class ChildCreateTests(ChildrenAPITestCase):
    def test_create_missing_required_fields(self, mock_children_db):
        resp = self.client.post('/api/v1/children/', {"centre": CENTRE_ID}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        for field in ("first_name", "last_name", "gender", "date_of_birth", "start_date"):
            self.assertIn(field, resp.data)
        mock_children_db.create_child.assert_not_called()

    def test_create_without_centre_is_rejected(self, mock_children_db):
        resp = self.client.post('/api/v1/children/', VALID_CHILD_PAYLOAD, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("centre", resp.data)
        mock_children_db.create_child.assert_not_called()

    def test_create_centre_from_nested_url(self, mock_children_db):
        mock_children_db.create_child.return_value = {"id": CHILD_ID}

        resp = self.client.post(f'/api/v1/centres/{CENTRE_ID}/children/', VALID_CHILD_PAYLOAD, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent_data = mock_children_db.create_child.call_args[0][0]
        self.assertEqual(sent_data["centre_id"], CENTRE_ID)

    def test_create_centre_and_session_from_body(self, mock_children_db):
        mock_children_db.create_child.return_value = {"id": CHILD_ID}
        session_id = "session-1"
        payload = {**VALID_CHILD_PAYLOAD, "centre": CENTRE_ID, "session": session_id}

        resp = self.client.post('/api/v1/children/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent_data = mock_children_db.create_child.call_args[0][0]
        self.assertEqual(sent_data["centre_id"], CENTRE_ID)
        self.assertEqual(sent_data["session_id"], session_id)
        self.assertNotIn("centre", sent_data)
        self.assertNotIn("session", sent_data)

    def test_create_rejects_invalid_date_format(self, mock_children_db):
        payload = {**VALID_CHILD_PAYLOAD, "centre": CENTRE_ID, "dateOfBirth": "01/01/2020"}

        resp = self.client.post('/api/v1/children/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("date_of_birth", resp.data)
        mock_children_db.create_child.assert_not_called()

    def test_create_rejects_future_date_of_birth(self, mock_children_db):
        payload = {**VALID_CHILD_PAYLOAD, "centre": CENTRE_ID, "dateOfBirth": "2099-01-01"}

        resp = self.client.post('/api/v1/children/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("cannot be in the future", resp.data["date_of_birth"][0])
        mock_children_db.create_child.assert_not_called()

    def test_create_rejects_start_date_before_date_of_birth(self, mock_children_db):
        payload = {**VALID_CHILD_PAYLOAD, "centre": CENTRE_ID, "startDate": "2019-01-01"}

        resp = self.client.post('/api/v1/children/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("cannot be before date of birth", resp.data["start_date"][0])
        mock_children_db.create_child.assert_not_called()

    def test_create_success(self, mock_children_db):
        mock_children_db.create_child.return_value = {"id": CHILD_ID, **VALID_CHILD_PAYLOAD}
        payload = {**VALID_CHILD_PAYLOAD, "centre": CENTRE_ID}

        resp = self.client.post('/api/v1/children/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)


@patch('children.views.send_child_registered_email')
@patch('children.views.centres_db')
@patch('children.views.children_db')
class ChildCreateEmailHookTests(ChildrenAPITestCase):
    def test_create_success_sends_onboarding_email(self, mock_children_db, mock_centres_db, mock_send_email):
        mock_children_db.create_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID, **VALID_CHILD_PAYLOAD}
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Test Centre"}
        
        payload = {**VALID_CHILD_PAYLOAD, "centre": CENTRE_ID}
        resp = self.client.post('/api/v1/children/', payload, format='json')
        
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_send_email.assert_called_once_with(
            mock_children_db.create_child.return_value,
            mock_centres_db.get_centre.return_value
        )


# =============================================================================
# ChildViewSet: partial_update
# =============================================================================

@patch('children.views.children_db')
class ChildUpdateTests(ChildrenAPITestCase):
    def test_update_not_found(self, mock_children_db):
        mock_children_db.get_child.return_value = None

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/', {"firstName": "New"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_update_scope_mismatch_is_404(self, mock_children_db):
        other_centre = "77777777-7777-7777-7777-777777777777"
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": other_centre}

        resp = self.client.patch(
            f'/api/v1/centres/{CENTRE_ID}/children/{CHILD_ID}/', {"firstName": "New"}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_children_db.update_child.assert_not_called()

    def test_update_remaps_centre_and_session_keys(self, mock_children_db):
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}
        mock_children_db.update_child.return_value = {"id": CHILD_ID}

        resp = self.client.patch(
            f'/api/v1/children/{CHILD_ID}/', {"centre": CENTRE_ID, "session": "session-2"}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sent_updates = mock_children_db.update_child.call_args[0][1]
        self.assertEqual(sent_updates["centre_id"], CENTRE_ID)
        self.assertEqual(sent_updates["session_id"], "session-2")
        self.assertNotIn("centre", sent_updates)
        self.assertNotIn("session", sent_updates)

    def test_update_success(self, mock_children_db):
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}
        mock_children_db.update_child.return_value = {"id": CHILD_ID, "first_name": "New"}

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/', {"firstName": "New"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_children_db.update_child.assert_called_once_with(CHILD_ID, {"first_name": "New"})


# =============================================================================
# ChildViewSet: destroy
# =============================================================================

@patch('children.views.progress_db')
@patch('children.views.children_db')
class ChildDestroyTests(ChildrenAPITestCase):
    def test_destroy_not_found(self, mock_children_db, mock_progress_db):
        mock_children_db.get_child.return_value = None

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_destroy_scope_mismatch_is_404(self, mock_children_db, mock_progress_db):
        other_centre = "77777777-7777-7777-7777-777777777777"
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": other_centre}

        resp = self.client.delete(f'/api/v1/centres/{CENTRE_ID}/children/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_children_db.delete_child.assert_not_called()

    def test_destroy_cascades_related_records(self, mock_children_db, mock_progress_db):
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}
        mock_children_db.list_contacts.return_value = [{"id": "contact-1"}]
        mock_children_db.list_enrolments.return_value = [{"id": "enrolment-1"}]
        mock_progress_db.list_attendance.return_value = [{"id": "attendance-1"}]
        mock_progress_db.list_journey.return_value = [{"id": "journey-1"}]
        mock_progress_db.list_notes.return_value = [{"id": "note-1"}]

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_children_db.delete_contact.assert_called_once_with("contact-1")
        mock_children_db.delete_enrolment.assert_called_once_with("enrolment-1")
        mock_progress_db.delete_attendance.assert_called_once_with("attendance-1")
        mock_progress_db.delete_journey_entry.assert_called_once_with("journey-1")
        mock_progress_db.delete_note.assert_called_once_with("note-1")
        mock_progress_db.delete_course_progress.assert_called_once_with(CHILD_ID)
        mock_children_db.delete_child.assert_called_once_with(CHILD_ID)


# =============================================================================
# ContactViewSet
# =============================================================================

@patch('children.views.children_db')
class ContactListTests(ChildrenAPITestCase):
    def test_list_without_child_returns_empty(self, mock_children_db):
        resp = self.client.get('/api/v1/contacts/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [])
        mock_children_db.list_contacts.assert_not_called()

    def test_list_contacts_for_child(self, mock_children_db):
        mock_children_db.list_contacts.return_value = [{"id": CONTACT_ID, "child_id": CHILD_ID}]

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/contacts/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_children_db.list_contacts.assert_called_once_with(CHILD_ID)


@patch('children.views.children_db')
class ContactRetrieveTests(ChildrenAPITestCase):
    def test_retrieve_not_found(self, mock_children_db):
        mock_children_db.get_contact.return_value = None

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_scope_mismatch_is_404(self, mock_children_db):
        other_child = "77777777-7777-7777-7777-777777777777"
        mock_children_db.get_contact.return_value = {"id": CONTACT_ID, "child_id": other_child}

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_found(self, mock_children_db):
        mock_children_db.get_contact.return_value = {"id": CONTACT_ID, "child_id": CHILD_ID}

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_retrieve_standalone_route_skips_scope_check(self, mock_children_db):
        mock_children_db.get_contact.return_value = {"id": CONTACT_ID, "child_id": CHILD_ID}

        resp = self.client.get(f'/api/v1/contacts/{CONTACT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)


@patch('children.views.children_db')
class ContactCreateTests(ChildrenAPITestCase):
    def test_create_without_child_is_rejected(self, mock_children_db):
        resp = self.client.post('/api/v1/contacts/', VALID_CONTACT_PAYLOAD, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("A child is required", resp.data["detail"])
        mock_children_db.create_contact.assert_not_called()

    def test_create_missing_required_fields(self, mock_children_db):
        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/contacts/', {}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        for field in ("name", "relation", "phone", "email"):
            self.assertIn(field, resp.data)
        mock_children_db.create_contact.assert_not_called()

    def test_create_success(self, mock_children_db):
        mock_children_db.create_contact.return_value = {"id": CONTACT_ID, **VALID_CONTACT_PAYLOAD}

        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/contacts/', VALID_CONTACT_PAYLOAD, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_children_db.create_contact.assert_called_once_with(CHILD_ID, VALID_CONTACT_PAYLOAD)


@patch('children.views.children_db')
class ContactUpdateDestroyTests(ChildrenAPITestCase):
    def test_update_not_found(self, mock_children_db):
        mock_children_db.get_contact.return_value = None

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/', {"name": "New"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_update_scope_mismatch_is_404(self, mock_children_db):
        other_child = "77777777-7777-7777-7777-777777777777"
        mock_children_db.get_contact.return_value = {"id": CONTACT_ID, "child_id": other_child}

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/', {"name": "New"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_children_db.update_contact.assert_not_called()

    def test_update_success(self, mock_children_db):
        mock_children_db.get_contact.return_value = {"id": CONTACT_ID, "child_id": CHILD_ID}
        mock_children_db.update_contact.return_value = {"id": CONTACT_ID, "name": "New"}

        resp = self.client.patch(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/', {"name": "New"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_children_db.update_contact.assert_called_once_with(CONTACT_ID, {"name": "New"})

    def test_destroy_not_found(self, mock_children_db):
        mock_children_db.get_contact.return_value = None

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_destroy_scope_mismatch_is_404(self, mock_children_db):
        other_child = "77777777-7777-7777-7777-777777777777"
        mock_children_db.get_contact.return_value = {"id": CONTACT_ID, "child_id": other_child}

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_children_db.delete_contact.assert_not_called()

    def test_destroy_success(self, mock_children_db):
        mock_children_db.get_contact.return_value = {"id": CONTACT_ID, "child_id": CHILD_ID}

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/contacts/{CONTACT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_children_db.delete_contact.assert_called_once_with(CONTACT_ID)


# =============================================================================
# EnrolmentViewSet
# =============================================================================

@patch('children.views.children_db')
class EnrolmentListTests(ChildrenAPITestCase):
    def test_list_without_child_returns_empty(self, mock_children_db):
        resp = self.client.get('/api/v1/enrolments/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [])
        mock_children_db.list_enrolments.assert_not_called()

    def test_list_enrolments_for_child(self, mock_children_db):
        mock_children_db.list_enrolments.return_value = [{"id": ENROLMENT_ID, "child_id": CHILD_ID}]

        resp = self.client.get(f'/api/v1/children/{CHILD_ID}/enrolments/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # Cancelled places are history, not a current booking.
        mock_children_db.list_enrolments.assert_called_once_with(
            CHILD_ID, include_cancelled=False)

    def test_the_activity_feed_can_ask_for_cancelled_places(self, mock_children_db):
        mock_children_db.list_enrolments.return_value = []

        self.client.get(f'/api/v1/children/{CHILD_ID}/enrolments/?include_cancelled=1')

        mock_children_db.list_enrolments.assert_called_once_with(
            CHILD_ID, include_cancelled=True)


@patch('children.views.send_enrolment_added_email')
@patch('children.views.centres_db')
@patch('children.views.sessions_db')
@patch('children.views.children_db')
class EnrolmentCreateTests(ChildrenAPITestCase):
    def test_create_nested_under_child_sets_child_id(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_added_email
    ):
        mock_children_db.create_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID}
        mock_children_db.get_child.return_value = None  # not the concern of this test; see email hook tests below
        payload = {"startDate": "2023-01-01", "endDate": "2023-12-31"}

        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/enrolments/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent_data = mock_children_db.create_enrolment.call_args[0][0]
        self.assertEqual(sent_data["child_id"], CHILD_ID)

    def test_create_standalone_requires_child_id_in_body(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_added_email
    ):
        mock_children_db.create_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID}
        mock_children_db.get_child.return_value = None
        payload = {"childId": CHILD_ID, "startDate": "2023-01-01", "endDate": "2023-12-31"}

        resp = self.client.post('/api/v1/enrolments/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent_data = mock_children_db.create_enrolment.call_args[0][0]
        self.assertEqual(sent_data["child_id"], CHILD_ID)

    def test_create_with_unresolvable_child_sends_no_email(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_added_email
    ):
        mock_children_db.create_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID}
        mock_children_db.get_child.return_value = None

        resp = self.client.post(f'/api/v1/children/{CHILD_ID}/enrolments/', {"startDate": "2023-01-01"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_send_enrolment_added_email.assert_not_called()

    def test_create_with_resolvable_child_sends_added_email(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_added_email
    ):
        slot_id = "77777777-7777-7777-7777-777777777777"
        mock_children_db.create_enrolment.return_value = {
            "id": ENROLMENT_ID, "child_id": CHILD_ID, "slot_id": slot_id,
        }
        child = {"id": CHILD_ID, "first_name": "Kid", "centre_id": CENTRE_ID, "contacts": []}
        slot = {"id": slot_id, "session_id": "session-1", "room_id": "room-1", "centre_id": CENTRE_ID}
        session = {"id": "session-1", "name": "Morning"}
        centre = {"id": CENTRE_ID, "name": "Centre A"}
        room = {"id": "room-1", "name": "Room 1"}
        mock_children_db.get_child.return_value = child
        mock_sessions_db.get_slot.return_value = slot
        mock_sessions_db.get_session.return_value = session
        mock_centres_db.get_centre.return_value = centre
        mock_centres_db.get_room.return_value = room

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/enrolments/', {"slotId": slot_id}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_send_enrolment_added_email.assert_called_once_with(child, slot, session, centre, room=room)

    def test_create_with_notify_false_sends_no_email(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_added_email
    ):
        mock_children_db.create_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID, "slot_id": "s1"}
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "centre_id": CENTRE_ID}

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/enrolments/', {"slotId": "s1", "notify": False}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_send_enrolment_added_email.assert_not_called()
        self.assertNotIn("notify", mock_children_db.create_enrolment.call_args[0][0])

    def test_create_with_notify_summary_sends_one_email_listing_every_class(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_added_email
    ):
        from django.core import mail
        child = {"id": CHILD_ID, "first_name": "Aarav", "last_name": "Patel", "centre_id": CENTRE_ID,
                 "contacts": [{"invite_as": "Parent", "email": "parent@example.com"}]}
        # Three weekly Puppy classes and one Bear class; "b" is the booking being made now.
        slots = {
            f"s{i}": {"id": f"s{i}", "centre_id": CENTRE_ID, "session_id": "puppy", "room_id": "r1",
                      "day": "tue", "start_time": "11:00", "start_date": d}
            for i, d in enumerate(["2026-10-06", "2026-10-13", "2026-10-20"])
        }
        slots["b"] = {"id": "b", "centre_id": CENTRE_ID, "session_id": "bear", "room_id": "r1",
                      "day": "thu", "start_time": "09:00", "start_date": "2026-10-08"}
        mock_children_db.create_enrolment.return_value = {"id": "e-b", "child_id": CHILD_ID, "slot_id": "b"}
        mock_children_db.get_child.return_value = child
        # The index hasn't caught up with the booking just made ("b"): it must still be listed, once.
        mock_children_db.list_enrolments.return_value = [
            {"id": f"e-{k}", "child_id": CHILD_ID, "slot_id": k} for k in slots if k != "b"
        ]
        mock_sessions_db.get_slot.side_effect = lambda sid: slots[sid]
        mock_sessions_db.get_session.side_effect = lambda sid, centre_id=None: {"name": sid.capitalize()}
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Indiranagar"}
        mock_centres_db.get_room.return_value = {"name": "Room 1"}

        resp = self.client.post(
            f'/api/v1/children/{CHILD_ID}/enrolments/', {"slotId": "b", "notify": "summary"}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_send_enrolment_added_email.assert_not_called()
        self.assertEqual(len(mail.outbox), 1)
        body = mail.outbox[0].body
        self.assertIn("Puppy — Tue 11:00 — Room: Room 1 (3 classes, 2026-10-06 to 2026-10-20)", body)
        self.assertIn("Bear — Thu 09:00 — Room: Room 1 (2026-10-08)", body)
        self.assertEqual(mail.outbox[0].to, ["parent@example.com"])


@patch('children.views.send_enrolment_removed_email')
@patch('children.views.centres_db')
@patch('children.views.sessions_db')
@patch('children.views.children_db')
class EnrolmentRetrieveUpdateDestroyTests(ChildrenAPITestCase):
    def test_retrieve_not_found(self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email):
        mock_children_db.get_enrolment.return_value = None

        resp = self.client.get(f'/api/v1/enrolments/{ENROLMENT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_found(self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email):
        mock_children_db.get_enrolment.return_value = {"id": ENROLMENT_ID}

        resp = self.client.get(f'/api/v1/enrolments/{ENROLMENT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_update_not_found(self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email):
        mock_children_db.get_enrolment.return_value = None

        resp = self.client.patch(f'/api/v1/enrolments/{ENROLMENT_ID}/', {"endDate": "2024-01-01"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_children_db.update_enrolment.assert_not_called()

    def test_update_success(self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email):
        mock_children_db.get_enrolment.return_value = {"id": ENROLMENT_ID}
        mock_children_db.update_enrolment.return_value = {"id": ENROLMENT_ID, "end_date": "2024-01-01"}

        resp = self.client.patch(f'/api/v1/enrolments/{ENROLMENT_ID}/', {"endDate": "2024-01-01"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_children_db.update_enrolment.assert_called_once_with(ENROLMENT_ID, {"end_date": "2024-01-01"})
        # No slot/slot_id in the payload — not a reschedule, so no context resolution or email.
        mock_children_db.get_child.assert_not_called()
        mock_send_enrolment_removed_email.assert_not_called()

    def test_destroy_not_found_via_standalone_route(self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email):
        mock_children_db.get_enrolment.return_value = None

        resp = self.client.delete(f'/api/v1/enrolments/{ENROLMENT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_children_db.delete_enrolment.assert_not_called()

    def test_destroy_success_via_nested_route(self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email):
        mock_children_db.get_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID}
        mock_children_db.get_child.return_value = None  # not the concern of this test; see email hook tests below

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/enrolments/{ENROLMENT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)


# =============================================================================
# EnrolmentViewSet: destroy / slot-change email hooks (Req: child removed /
# slot changes notify parent contacts + centre admins)
# =============================================================================

@patch('children.views.send_enrolment_removed_email')
@patch('children.views.centres_db')
@patch('children.views.sessions_db')
@patch('children.views.children_db')
class EnrolmentDestroyEmailHookTests(ChildrenAPITestCase):
    def test_destroy_with_resolvable_child_sends_removed_email(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email
    ):
        slot_id = "77777777-7777-7777-7777-777777777777"
        mock_children_db.get_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID, "slot_id": slot_id}
        child = {"id": CHILD_ID, "first_name": "Kid", "centre_id": CENTRE_ID, "contacts": []}
        slot = {"id": slot_id, "session_id": "session-1", "room_id": "room-1"}
        session = {"id": "session-1", "name": "Morning"}
        centre = {"id": CENTRE_ID, "name": "Centre A"}
        room = {"id": "room-1", "name": "Room 1"}
        mock_children_db.get_child.return_value = child
        mock_sessions_db.get_slot.return_value = slot
        mock_sessions_db.get_session.return_value = session
        mock_centres_db.get_centre.return_value = centre
        mock_centres_db.get_room.return_value = room

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/enrolments/{ENROLMENT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_send_enrolment_removed_email.assert_called_once_with(
            child, slot, session, centre, reason='removed', room=room
        )

    def test_destroy_resolves_context_before_deleting(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email
    ):
        # The enrolment (and its slot_id) must be read before delete_enrolment runs,
        # otherwise there's nothing left to resolve the notification context from.
        mock_children_db.get_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID}
        mock_children_db.get_child.return_value = {"id": CHILD_ID, "contacts": []}

        self.client.delete(f'/api/v1/children/{CHILD_ID}/enrolments/{ENROLMENT_ID}/')

        # Called once for the centre-scope check and again to resolve the
        # notification context — both before delete_enrolment runs.
        mock_children_db.get_child.assert_any_call(CHILD_ID)
        mock_children_db.delete_enrolment.assert_called_once_with(ENROLMENT_ID)

    def test_destroy_with_unresolvable_child_sends_no_email(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email
    ):
        mock_children_db.get_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID}
        mock_children_db.get_child.return_value = None

        resp = self.client.delete(f'/api/v1/children/{CHILD_ID}/enrolments/{ENROLMENT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_send_enrolment_removed_email.assert_not_called()


@patch('children.views.send_enrolment_removed_email')
@patch('children.views.centres_db')
@patch('children.views.sessions_db')
@patch('children.views.children_db')
class EnrolmentSlotChangeEmailHookTests(ChildrenAPITestCase):
    def test_changing_slot_sends_rescheduled_email(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email
    ):
        old_slot_id = "77777777-7777-7777-7777-777777777777"
        new_slot_id = "88888888-8888-8888-8888-888888888888"
        mock_children_db.get_enrolment.return_value = {
            "id": ENROLMENT_ID, "child_id": CHILD_ID, "slot_id": old_slot_id,
        }
        updated = {"id": ENROLMENT_ID, "child_id": CHILD_ID, "slot_id": new_slot_id}
        mock_children_db.update_enrolment.return_value = updated
        child = {"id": CHILD_ID, "first_name": "Kid", "centre_id": CENTRE_ID, "contacts": []}
        new_slot = {"id": new_slot_id, "session_id": "session-1", "room_id": "room-1"}
        session = {"id": "session-1", "name": "Afternoon"}
        centre = {"id": CENTRE_ID, "name": "Centre A"}
        room = {"id": "room-1", "name": "Room 1"}
        mock_children_db.get_child.return_value = child
        mock_sessions_db.get_slot.return_value = new_slot
        mock_sessions_db.get_session.return_value = session
        mock_centres_db.get_centre.return_value = centre
        mock_centres_db.get_room.return_value = room

        resp = self.client.patch(
            f'/api/v1/enrolments/{ENROLMENT_ID}/', {"slotId": new_slot_id}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # Resolves against the *new* slot (looked up from the updated enrolment), not the old one.
        mock_sessions_db.get_slot.assert_called_once_with(new_slot_id)
        mock_send_enrolment_removed_email.assert_called_once_with(
            child, new_slot, session, centre, reason='rescheduled', room=room
        )

    def test_setting_slot_to_the_same_value_sends_no_email(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email
    ):
        slot_id = "77777777-7777-7777-7777-777777777777"
        mock_children_db.get_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID, "slot_id": slot_id}
        mock_children_db.update_enrolment.return_value = {"id": ENROLMENT_ID, "slot_id": slot_id}

        resp = self.client.patch(f'/api/v1/enrolments/{ENROLMENT_ID}/', {"slotId": slot_id}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_send_enrolment_removed_email.assert_not_called()
        # get_child IS called once, for the centre-scope check — but slot didn't
        # change, so _resolve_enrolment_context's extra lookup is skipped.
        mock_children_db.get_child.assert_called_once_with(CHILD_ID)

    def test_unrelated_field_update_sends_no_email(
        self, mock_children_db, mock_sessions_db, mock_centres_db, mock_send_enrolment_removed_email
    ):
        mock_children_db.get_enrolment.return_value = {"id": ENROLMENT_ID, "child_id": CHILD_ID, "slot_id": "s1"}
        mock_children_db.update_enrolment.return_value = {"id": ENROLMENT_ID, "end_date": "2024-01-01"}

        resp = self.client.patch(f'/api/v1/enrolments/{ENROLMENT_ID}/', {"endDate": "2024-01-01"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_send_enrolment_removed_email.assert_not_called()


# =============================================================================
# Permission-matrix enforcement (dynamic role-based access — see roles/access.py)
# =============================================================================

class ChildEnforcementTests(ChildrenAPITestCase):
    """Unlike the rest of this file, these tests give the acting user a
    restricted (non-root) UserAccess to verify the enforcement itself,
    rather than the business logic downstream of it.
    """

    @patch('children.views.children_db')
    def test_list_returns_404_for_centre_the_user_is_not_a_member_of(self, mock_children_db):
        self.mock_get_user_access.return_value = UserAccess(unrestricted=False)

        resp = self.client.get(f'/api/v1/children/?centre={CENTRE_ID}')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_children_db.list_children.assert_not_called()

    @patch('children.views.children_db')
    def test_list_returns_403_when_member_lacks_view_permission(self, mock_children_db):
        access = UserAccess(unrestricted=False)
        access.centres[CENTRE_ID] = {
            'data_scope': 'own', 'role_names': ['Teacher'], 'name': '', 'system_id': '',
            'permissions': {},  # no children.view_info
        }
        self.mock_get_user_access.return_value = access

        resp = self.client.get(f'/api/v1/children/?centre={CENTRE_ID}')

        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        mock_children_db.list_children.assert_not_called()

    @patch('children.views.children_db')
    def test_list_succeeds_when_member_has_view_permission(self, mock_children_db):
        access = UserAccess(unrestricted=False)
        access.centres[CENTRE_ID] = {
            'data_scope': 'own', 'role_names': ['Teacher'], 'name': '', 'system_id': '',
            'permissions': {'children.view_info': {'visible': True, 'edit': False}},
        }
        self.mock_get_user_access.return_value = access
        mock_children_db.list_children.return_value = []

        resp = self.client.get(f'/api/v1/children/?centre={CENTRE_ID}')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_children_db.list_children.assert_called_once_with(CENTRE_ID, archived=False)

    @patch('children.views.children_db')
    def test_create_returns_403_when_member_can_view_but_not_add(self, mock_children_db):
        access = UserAccess(unrestricted=False)
        access.centres[CENTRE_ID] = {
            'data_scope': 'own', 'role_names': ['Teacher'], 'name': '', 'system_id': '',
            'permissions': {'children.view_info': {'visible': True, 'edit': False}},
        }
        self.mock_get_user_access.return_value = access

        resp = self.client.post('/api/v1/children/', {**VALID_CHILD_PAYLOAD, "centre": CENTRE_ID}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        mock_children_db.create_child.assert_not_called()
