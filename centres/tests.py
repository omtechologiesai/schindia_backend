"""
API tests for the centres app.

Same approach as billing/tests.py: SimpleTestCase (settings.DATABASES is a dummy
backend, so no TestCase/transaction machinery), dynamo_backend.services mocked at
the point they're imported into centres.views, and force_authenticate() with a
lightweight fake user instead of real JWTs.
"""
from unittest.mock import patch

from django.test import SimpleTestCase
from rest_framework import status
from rest_framework.test import APIClient

from roles.permissions_catalog import ALL_PERMISSION_KEYS
from roles.access import UserAccess

CENTRE_ID = "22222222-2222-2222-2222-222222222222"
ROOM_ID = "66666666-6666-6666-6666-666666666666"
USER_ID = "55555555-5555-5555-5555-555555555555"

VALID_CENTRE_PAYLOAD = {
    "name": "Test Centre",
    "streetAddress": "123 Street",
    "city": "Mumbai",
    "postcode": "400001",
    "phone": "9876543210",
    "email": "centre@example.com",
    "bankDetails": {
        "accountHolderName": "A",
        "bankName": "B",
        "accountNumber": "12345678",
        "ifscCode": "ABCD0123456",
        "upiId": "a@b",
    },
}


class FakeUser:
    """Stand-in for schindia_auth.authentication.DynamoUser."""

    def __init__(self, user_id=USER_ID, status="approved", role="staff"):
        self.id = user_id
        self.pk = user_id
        self.is_authenticated = True
        self.is_anonymous = False
        self.status = status
        self.role = role
        self.email = "staff@example.com"

    def get_full_name(self):
        return "Staff Person"


class CentresAPITestCase(SimpleTestCase):
    """Grants the acting user unrestricted access by default (root-equivalent
    UserAccess), so these tests exercise business logic rather than the
    permission matrix — see roles/test_access.py for that. Tests that need to
    assert enforcement itself override self.mock_get_user_access.return_value.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = FakeUser()
        self.client.force_authenticate(user=self.user)

        access_patcher = patch('centres.views.get_user_access')
        self.mock_get_user_access = access_patcher.start()
        self.mock_get_user_access.return_value = UserAccess(unrestricted=True)
        self.addCleanup(access_patcher.stop)


# =============================================================================
# Permissions
# =============================================================================

class CentresPermissionsTests(SimpleTestCase):
    ENDPOINTS = [
        ("get", "/api/v1/centres/"),
        ("get", f"/api/v1/centres/{CENTRE_ID}/"),
        ("post", "/api/v1/centres/"),
        ("get", f"/api/v1/centres/{CENTRE_ID}/rooms/"),
        ("get", f"/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/"),
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
# CentreViewSet: list / retrieve
# =============================================================================

@patch('centres.views.centres_db')
class CentreListRetrieveTests(CentresAPITestCase):
    def test_list_centres(self, mock_centres_db):
        mock_centres_db.list_centres.return_value = [{"id": CENTRE_ID, "name": "Centre A"}]

        resp = self.client.get('/api/v1/centres/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, [{"id": CENTRE_ID, "name": "Centre A"}])

    def test_retrieve_centre_found(self, mock_centres_db):
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Centre A"}

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_centres_db.get_centre.assert_called_once_with(CENTRE_ID)

    def test_retrieve_centre_not_found(self, mock_centres_db):
        mock_centres_db.get_centre.return_value = None

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


# =============================================================================
# CentreViewSet: create
# =============================================================================

@patch('centres.views.roles_db')
@patch('centres.views.centres_db')
class CentreCreateTests(CentresAPITestCase):
    def test_create_missing_required_fields_returns_400(self, mock_centres_db, mock_roles_db):
        # bank_details is deliberately excluded here — see the
        # test_create_silently_allows_bank_details_to_be_omitted_entirely gotcha below.
        resp = self.client.post('/api/v1/centres/', {}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        for field in ("name", "street_address", "city", "postcode", "phone", "email"):
            self.assertIn(field, resp.data)
        mock_centres_db.create_centre.assert_not_called()

    def test_create_requires_bank_details_when_sent_as_null_or_empty(self, mock_centres_db, mock_roles_db):
        for empty_value in (None, {}):
            with self.subTest(bank_details=empty_value):
                payload = {**VALID_CENTRE_PAYLOAD, "bankDetails": empty_value}

                resp = self.client.post('/api/v1/centres/', payload, format='json')

                self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("bank_details", resp.data)

    def test_create_requires_bank_details_when_omitted_entirely(self, mock_centres_db, mock_roles_db):
        """
        CentreCreateSerializer.bank_details has default=None (see PR #15 review), so
        validate_bank_details() runs even when the key is left out of the request body
        entirely — not just when it's sent explicitly as null or {} (see the test above).
        A client that omits the key gets the same "bank details required" rejection.
        """
        payload = {k: v for k, v in VALID_CENTRE_PAYLOAD.items() if k != "bankDetails"}

        resp = self.client.post('/api/v1/centres/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("bank_details", resp.data)
        mock_centres_db.create_centre.assert_not_called()

    def test_create_rejects_invalid_postcode(self, mock_centres_db, mock_roles_db):
        payload = {**VALID_CENTRE_PAYLOAD, "postcode": "abc"}

        resp = self.client.post('/api/v1/centres/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("postcode", resp.data)

    def test_create_rejects_invalid_phone_length(self, mock_centres_db, mock_roles_db):
        payload = {**VALID_CENTRE_PAYLOAD, "phone": "123"}

        resp = self.client.post('/api/v1/centres/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("phone", resp.data)

    def test_create_rejects_invalid_ifsc_code(self, mock_centres_db, mock_roles_db):
        payload = {
            **VALID_CENTRE_PAYLOAD,
            "bankDetails": {**VALID_CENTRE_PAYLOAD["bankDetails"], "ifscCode": "not-an-ifsc"},
        }

        resp = self.client.post('/api/v1/centres/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("bank_details", resp.data)

    def test_a_closure_can_be_recorded_after_the_fact(self, mock_centres_db, mock_roles_db):
        """
        Closure dates are no longer required to be in the future.

        A centre that shut last week is a fact to record, not a mistake to
        reject — the previous rule made it impossible to enter one late.
        """
        mock_centres_db.create_centre.return_value = {"id": CENTRE_ID}
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Test Centre"}
        mock_roles_db.create_role.return_value = {"id": "role-1"}
        payload = {
            **VALID_CENTRE_PAYLOAD,
            "closureDates": [{"date": "2020-01-01", "reason": "Holiday"}],
        }

        resp = self.client.post('/api/v1/centres/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_create_success_provisions_rooms_and_admin_role(self, mock_centres_db, mock_roles_db):
        mock_centres_db.create_centre.return_value = {"id": CENTRE_ID}
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Test Centre", "rooms": [{"name": "Room 1"}]}
        mock_roles_db.create_role.return_value = {"id": "role-1"}
        payload = {**VALID_CENTRE_PAYLOAD, "rooms": [{"name": "Room 1"}]}

        resp = self.client.post('/api/v1/centres/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        # Centre created without the nested rooms payload (rooms handled separately)
        created_data = mock_centres_db.create_centre.call_args[0][0]
        self.assertNotIn("rooms", created_data)
        self.assertEqual(created_data["name"], "Test Centre")

        # Room created against the new centre
        mock_centres_db.create_room.assert_called_once_with(CENTRE_ID, {"name": "Room 1"})

        # Default Admin role created with every catalog permission, editable + visible,
        # plus the admin-lockout keys (people.manage/roles.manage) so the creator isn't
        # locked out of managing their own centre's roles/people.
        role_args = mock_roles_db.create_role.call_args[0]
        self.assertEqual(role_args[0], CENTRE_ID)
        role_data = role_args[1]
        self.assertEqual(role_data["name"], "Admin")
        self.assertEqual(role_data["data_scope"], "all")
        sent_keys = [p["key"] for p in role_data["permissions"]]
        self.assertEqual(sent_keys, ALL_PERMISSION_KEYS + ["people.manage", "roles.manage"])
        self.assertTrue(all(p["edit"] and p["visible"] for p in role_data["permissions"]))

        # Requesting user added as a member of that role
        mock_roles_db.add_member.assert_called_once_with(
            "role-1", USER_ID, name="Staff Person", email="staff@example.com"
        )

        # Response reflects the refreshed centre (post-room-creation)
        mock_centres_db.get_centre.assert_called_once_with(CENTRE_ID)
        self.assertEqual(resp.data["rooms"], [{"name": "Room 1"}])


# =============================================================================
# CentreViewSet: partial_update
# =============================================================================

@patch('centres.views.centres_db')
class CentreUpdateTests(CentresAPITestCase):
    def test_update_centre_not_found(self, mock_centres_db):
        mock_centres_db.get_centre.return_value = None

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/', {"name": "New Name"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_update_centre_validates_partial_payload(self, mock_centres_db):
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Centre A"}

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/', {"postcode": "bad"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("postcode", resp.data)
        mock_centres_db.update_centre.assert_not_called()

    def test_update_centre_success(self, mock_centres_db):
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Centre A"}
        mock_centres_db.update_centre.return_value = {"id": CENTRE_ID, "name": "Renamed"}

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/', {"name": "Renamed"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["name"], "Renamed")
        mock_centres_db.update_centre.assert_called_once_with(CENTRE_ID, {"name": "Renamed"})

    def test_update_returns_404_if_update_race_loses_the_centre(self, mock_centres_db):
        # get_centre finds it, but update_centre comes back empty (e.g. deleted concurrently)
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "name": "Centre A"}
        mock_centres_db.update_centre.return_value = None

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/', {"name": "Renamed"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


# =============================================================================
# CentreViewSet: destroy
# =============================================================================

@patch('centres.views.roles_db')
@patch('centres.views.children_db')
@patch('centres.views.sessions_db')
@patch('centres.views.centres_db')
class CentreDestroyTests(CentresAPITestCase):
    def test_destroy_centre_not_found(self, mock_centres_db, mock_sessions_db, mock_children_db, mock_roles_db):
        mock_centres_db.get_centre.return_value = None

        resp = self.client.delete(f'/api/v1/centres/{CENTRE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_destroy_blocked_by_enrolled_children(self, mock_centres_db, mock_sessions_db, mock_children_db, mock_roles_db):
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "rooms": []}
        mock_children_db.list_children.return_value = [{"id": "child-1"}]

        resp = self.client.delete(f'/api/v1/centres/{CENTRE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("children", resp.data["detail"])
        mock_centres_db.delete_centre.assert_not_called()

    def test_destroy_blocked_by_active_role_members(self, mock_centres_db, mock_sessions_db, mock_children_db, mock_roles_db):
        mock_centres_db.get_centre.return_value = {"id": CENTRE_ID, "rooms": []}
        mock_children_db.list_children.return_value = []
        mock_roles_db.list_roles.return_value = [{"id": "role-1", "members": [{"id": "member-1"}]}]

        resp = self.client.delete(f'/api/v1/centres/{CENTRE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("members", resp.data["detail"])
        mock_centres_db.delete_centre.assert_not_called()

    def test_destroy_success_cleans_up_rooms_and_roles(self, mock_centres_db, mock_sessions_db, mock_children_db, mock_roles_db):
        mock_centres_db.get_centre.return_value = {
            "id": CENTRE_ID, "rooms": [{"id": "room-1"}, {"id": "room-2"}],
        }
        mock_sessions_db.list_sessions.return_value = []
        mock_children_db.list_children.return_value = []
        mock_roles_db.list_roles.return_value = [{"id": "role-1", "members": []}]

        resp = self.client.delete(f'/api/v1/centres/{CENTRE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_centres_db.delete_room.assert_any_call("room-1")
        mock_centres_db.delete_room.assert_any_call("room-2")
        mock_roles_db.delete_role.assert_called_once_with("role-1")
        mock_centres_db.delete_centre.assert_called_once_with(CENTRE_ID)


# =============================================================================
# RoomViewSet
# =============================================================================

@patch('centres.views.centres_db')
class RoomListRetrieveTests(CentresAPITestCase):
    def test_list_rooms(self, mock_centres_db):
        mock_centres_db.get_rooms.return_value = [{"id": ROOM_ID, "name": "Room 1"}]

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/rooms/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_centres_db.get_rooms.assert_called_once_with(CENTRE_ID)

    def test_retrieve_room_found(self, mock_centres_db):
        mock_centres_db.get_room.return_value = {"id": ROOM_ID, "centre_id": CENTRE_ID}

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_retrieve_room_not_found(self, mock_centres_db):
        mock_centres_db.get_room.return_value = None

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_room_belonging_to_different_centre_is_404(self, mock_centres_db):
        other_centre = "77777777-7777-7777-7777-777777777777"
        mock_centres_db.get_room.return_value = {"id": ROOM_ID, "centre_id": other_centre}

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


@patch('centres.views.centres_db')
class RoomCreateTests(CentresAPITestCase):
    def test_create_room_missing_name(self, mock_centres_db):
        resp = self.client.post(f'/api/v1/centres/{CENTRE_ID}/rooms/', {"name": "  "}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", resp.data)
        mock_centres_db.create_room.assert_not_called()

    def test_create_room_name_too_long(self, mock_centres_db):
        resp = self.client.post(f'/api/v1/centres/{CENTRE_ID}/rooms/', {"name": "x" * 51}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", resp.data)

    def test_create_room_duplicate_name_case_insensitive(self, mock_centres_db):
        mock_centres_db.get_rooms.return_value = [{"id": "other-room", "name": "Sunflower"}]

        resp = self.client.post(f'/api/v1/centres/{CENTRE_ID}/rooms/', {"name": "sunflower"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("already exists", resp.data["name"][0])
        mock_centres_db.create_room.assert_not_called()

    def test_create_room_success(self, mock_centres_db):
        mock_centres_db.get_rooms.return_value = []
        mock_centres_db.create_room.return_value = {"id": ROOM_ID, "name": "Sunflower"}

        resp = self.client.post(f'/api/v1/centres/{CENTRE_ID}/rooms/', {"name": "  Sunflower  "}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_centres_db.create_room.assert_called_once_with(CENTRE_ID, {"name": "Sunflower"})


@patch('centres.views.centres_db')
class RoomUpdateTests(CentresAPITestCase):
    def test_update_room_blank_name(self, mock_centres_db):
        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/', {"name": "  "}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_centres_db.update_room.assert_not_called()

    def test_update_room_name_too_long(self, mock_centres_db):
        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/', {"name": "x" * 51}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_update_room_duplicate_name_excludes_self(self, mock_centres_db):
        # Same room keeping its own name shouldn't collide with itself
        mock_centres_db.get_rooms.return_value = [{"id": ROOM_ID, "name": "Sunflower"}]
        mock_centres_db.update_room.return_value = {"id": ROOM_ID, "name": "Sunflower"}

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/', {"name": "Sunflower"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_update_room_duplicate_name_against_other_room(self, mock_centres_db):
        mock_centres_db.get_rooms.return_value = [{"id": "other-room", "name": "Sunflower"}]

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/', {"name": "Sunflower"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_centres_db.update_room.assert_not_called()

    def test_update_room_without_name_change_skips_validation(self, mock_centres_db):
        mock_centres_db.update_room.return_value = {"id": ROOM_ID, "capacity": 10}

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/', {"capacity": 10}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_centres_db.get_rooms.assert_not_called()

    def test_update_room_not_found(self, mock_centres_db):
        mock_centres_db.update_room.return_value = None

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/', {"capacity": 10}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


@patch('centres.views.sessions_db')
@patch('centres.views.centres_db')
class RoomDestroyTests(CentresAPITestCase):
    def test_destroy_room_blocked_by_timetable_assignments(self, mock_centres_db, mock_sessions_db):
        mock_sessions_db.list_slots_by_room.return_value = [{"id": "slot-1"}]

        resp = self.client.delete(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_centres_db.delete_room.assert_not_called()

    def test_destroy_room_success(self, mock_centres_db, mock_sessions_db):
        mock_sessions_db.list_slots_by_room.return_value = []

        resp = self.client.delete(f'/api/v1/centres/{CENTRE_ID}/rooms/{ROOM_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_centres_db.delete_room.assert_called_once_with(ROOM_ID)


# =============================================================================
# Permission-matrix enforcement (dynamic role-based access — see roles/access.py)
# =============================================================================

@patch('centres.views.centres_db')
class CentreEnforcementTests(CentresAPITestCase):
    """Unlike the rest of this file, these tests give the acting user a
    restricted (non-root) UserAccess to verify the enforcement itself,
    rather than the business logic downstream of it.
    """

    def test_list_only_returns_centres_the_user_belongs_to(self, mock_centres_db):
        access = UserAccess(unrestricted=False)
        access.centres[CENTRE_ID] = {
            'data_scope': 'own', 'role_names': ['Manager'], 'name': '', 'system_id': '',
            'permissions': {},
        }
        self.mock_get_user_access.return_value = access
        mock_centres_db.list_centres.return_value = [
            {"id": CENTRE_ID, "name": "Centre A"},
            {"id": "other-centre", "name": "Centre B"},
        ]

        resp = self.client.get('/api/v1/centres/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual([c["id"] for c in resp.data], [CENTRE_ID])

    def test_retrieve_returns_404_for_centre_the_user_is_not_a_member_of(self, mock_centres_db):
        self.mock_get_user_access.return_value = UserAccess(unrestricted=False)

        resp = self.client.get(f'/api/v1/centres/{CENTRE_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_centres_db.get_centre.assert_not_called()

    def test_update_returns_403_without_configure_centre_settings_permission(self, mock_centres_db):
        access = UserAccess(unrestricted=False)
        access.centres[CENTRE_ID] = {
            'data_scope': 'own', 'role_names': ['Manager'], 'name': '', 'system_id': '',
            'permissions': {},  # no admin.configure_centre_settings
        }
        self.mock_get_user_access.return_value = access

        resp = self.client.patch(f'/api/v1/centres/{CENTRE_ID}/', {"name": "New Name"}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        mock_centres_db.update_centre.assert_not_called()
