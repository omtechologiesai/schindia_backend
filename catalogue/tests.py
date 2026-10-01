"""
API tests for the catalogue app (product catalogue items and discount rules).

Same approach as the other apps' suites: SimpleTestCase (settings.DATABASES is a dummy
backend), dynamo_backend.services mocked at the point it's imported into catalogue.views,
and force_authenticate() instead of real JWTs. Unlike roles/centres/billing, these
viewsets don't sit behind roles.access.get_user_access — IsAuthenticated + IsApprovedUser
is the whole gate — so there's no UserAccess mocking needed here.
"""
from unittest.mock import patch

from django.test import SimpleTestCase
from rest_framework import status
from rest_framework.test import APIClient

CENTRE_ID = "22222222-2222-2222-2222-222222222222"
OTHER_CENTRE_ID = "77777777-7777-7777-7777-777777777777"
ITEM_ID = "33333333-3333-3333-3333-333333333333"
DISCOUNT_ID = "44444444-4444-4444-4444-444444444444"


class FakeUser:
    def __init__(self, user_id="55555555-5555-5555-5555-555555555555", status="approved", role="staff"):
        self.id = user_id
        self.pk = user_id
        self.is_authenticated = True
        self.is_anonymous = False
        self.status = status
        self.role = role


class CatalogueAPITestCase(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = FakeUser()
        self.client.force_authenticate(user=self.user)


def global_item(item_id=ITEM_ID, code="REG-NEW", price=8000, active=True):
    return {
        'id': item_id, 'code': code, 'name': 'New admission registration',
        'category': 'registration', 'price': price, 'unit': 'one-time', 'active': active,
    }


def centre_item(item_id=ITEM_ID, code="MAT-KIT", centre_id=CENTRE_ID):
    return {
        'id': item_id, 'centre_id': centre_id, 'code': code, 'name': 'Course material kit',
        'category': 'material', 'price': 3500, 'unit': 'one-time', 'active': True,
    }


def global_discount(discount_id=DISCOUNT_ID, code="SIBLING10", value=10):
    return {
        'id': discount_id, 'code': code, 'name': 'Sibling discount',
        'kind': 'percent', 'value': value, 'active': True,
    }


# =============================================================================
# Permissions
# =============================================================================

class CataloguePermissionsTests(SimpleTestCase):
    ENDPOINTS = [
        ("get", "/api/v1/catalogue-items/"),
        ("get", f"/api/v1/catalogue-items/{ITEM_ID}/"),
        ("post", "/api/v1/catalogue-items/"),
        ("get", "/api/v1/discount-rules/"),
        ("get", f"/api/v1/discount-rules/{DISCOUNT_ID}/"),
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
# CatalogueItemViewSet: list / retrieve
# =============================================================================

@patch('catalogue.views.catalogue_db')
class CatalogueItemListRetrieveTests(CatalogueAPITestCase):
    def test_list_global_only_when_no_centre_given(self, mock_db):
        mock_db.list_items.return_value = [global_item()]

        resp = self.client.get('/api/v1/catalogue-items/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_db.list_items.assert_called_once_with(centre_id=None, include_inactive=True)

    def test_list_scoped_to_centre(self, mock_db):
        mock_db.list_items.return_value = [global_item(), centre_item()]

        resp = self.client.get(f'/api/v1/catalogue-items/?centre_id={CENTRE_ID}')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data), 2)
        mock_db.list_items.assert_called_once_with(centre_id=CENTRE_ID, include_inactive=True)

    def test_list_include_inactive_false(self, mock_db):
        mock_db.list_items.return_value = []

        resp = self.client.get('/api/v1/catalogue-items/?include_inactive=false')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_db.list_items.assert_called_once_with(centre_id=None, include_inactive=False)

    def test_retrieve_not_found(self, mock_db):
        mock_db.get_item.return_value = None

        resp = self.client.get(f'/api/v1/catalogue-items/{ITEM_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_found(self, mock_db):
        mock_db.get_item.return_value = global_item()

        resp = self.client.get(f'/api/v1/catalogue-items/{ITEM_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['code'], 'REG-NEW')


# =============================================================================
# CatalogueItemViewSet: create
# =============================================================================

@patch('catalogue.views.catalogue_db')
class CatalogueItemCreateTests(CatalogueAPITestCase):
    VALID_PAYLOAD = {
        'name': 'Workbook set', 'code': 'MAT-WKB', 'category': 'material',
        'price': 1200, 'unit': 'per session',
    }

    def test_unit_outside_the_enum_is_rejected(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'unit': 'per term'}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('unit', resp.data)
        mock_db.create_item.assert_not_called()

    def test_missing_name(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'name': '  '}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('name', resp.data)
        mock_db.create_item.assert_not_called()

    def test_missing_code(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'code': ''}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('code', resp.data)
        mock_db.create_item.assert_not_called()

    def test_price_zero_rejected(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'price': 0}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('price', resp.data)
        mock_db.create_item.assert_not_called()

    def test_price_negative_rejected(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'price': -50}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_db.create_item.assert_not_called()

    def test_invalid_price_type_rejected(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'price': 'not-a-number'}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('price', resp.data)

    def test_duplicate_code_in_same_scope_rejected(self, mock_db):
        mock_db.list_items.return_value = [global_item(code='MAT-WKB', item_id='other-id')]

        resp = self.client.post('/api/v1/catalogue-items/', self.VALID_PAYLOAD, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('code', resp.data)
        mock_db.create_item.assert_not_called()

    def test_duplicate_code_check_is_case_insensitive(self, mock_db):
        mock_db.list_items.return_value = [global_item(code='mat-wkb', item_id='other-id')]

        resp = self.client.post('/api/v1/catalogue-items/', self.VALID_PAYLOAD, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_success_defaults_category_and_unit_when_absent(self, mock_db):
        mock_db.list_items.return_value = []
        mock_db.create_item.return_value = {'id': ITEM_ID, **self.VALID_PAYLOAD}
        payload = {'name': 'Misc fee', 'code': 'MISC-1', 'price': 500}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        sent = mock_db.create_item.call_args[0][0]
        self.assertEqual(sent['category'], 'other')
        self.assertEqual(sent['unit'], 'per month')

    def test_success_scoped_to_a_centre(self, mock_db):
        mock_db.list_items.return_value = []
        mock_db.create_item.return_value = {'id': ITEM_ID, **self.VALID_PAYLOAD, 'centre_id': CENTRE_ID}
        payload = {**self.VALID_PAYLOAD, 'centreId': CENTRE_ID}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        # Code uniqueness for a centre-scoped item is only checked within that centre.
        mock_db.list_items.assert_called_once_with(centre_id=CENTRE_ID, include_inactive=True)
        sent = mock_db.create_item.call_args[0][0]
        self.assertEqual(sent['centre_id'], CENTRE_ID)

    def test_global_item_with_null_centre_is_created_global(self, mock_db):
        """Explicit null (not just an absent key) is how the frontend marks an
        item as global — see catalogue.ts's save functions on the frontend."""
        mock_db.list_items.return_value = []
        mock_db.create_item.return_value = {'id': ITEM_ID, **self.VALID_PAYLOAD}
        payload = {**self.VALID_PAYLOAD, 'centreId': None}

        resp = self.client.post('/api/v1/catalogue-items/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_db.list_items.assert_called_once_with(centre_id=None, include_inactive=True)


# =============================================================================
# CatalogueItemViewSet: partial_update
# =============================================================================

@patch('catalogue.views.catalogue_db')
class CatalogueItemUpdateTests(CatalogueAPITestCase):
    def test_not_found(self, mock_db):
        mock_db.get_item.return_value = None

        resp = self.client.patch(f'/api/v1/catalogue-items/{ITEM_ID}/', {'price': 9000}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_db.update_item.assert_not_called()

    def test_update_without_code_change_skips_clash_check(self, mock_db):
        mock_db.get_item.return_value = global_item()
        mock_db.update_item.return_value = {**global_item(), 'price': 9000}

        resp = self.client.patch(f'/api/v1/catalogue-items/{ITEM_ID}/', {'price': 9000}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_db.list_items.assert_not_called()
        mock_db.update_item.assert_called_once_with(ITEM_ID, {'price': 9000})

    def test_changing_unit_to_one_outside_the_enum_is_rejected(self, mock_db):
        mock_db.get_item.return_value = global_item()

        resp = self.client.patch(f'/api/v1/catalogue-items/{ITEM_ID}/', {'unit': 'per term'}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('unit', resp.data)
        mock_db.update_item.assert_not_called()

    def test_older_product_can_keep_its_existing_unit(self, mock_db):
        mock_db.get_item.return_value = global_item()  # unit 'one-time'
        mock_db.update_item.return_value = {**global_item(), 'price': 9000}

        resp = self.client.patch(f'/api/v1/catalogue-items/{ITEM_ID}/', {'price': 9000, 'unit': 'one-time'}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_unit_can_change_to_per_session(self, mock_db):
        mock_db.get_item.return_value = global_item()
        mock_db.update_item.return_value = {**global_item(), 'unit': 'per session'}

        resp = self.client.patch(f'/api/v1/catalogue-items/{ITEM_ID}/', {'unit': 'per session'}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_rename_code_clashing_with_another_item_is_rejected(self, mock_db):
        mock_db.get_item.return_value = global_item()
        mock_db.list_items.return_value = [global_item(code='REG-RE', item_id='other-id')]

        resp = self.client.patch(f'/api/v1/catalogue-items/{ITEM_ID}/', {'code': 'REG-RE'}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        mock_db.update_item.assert_not_called()

    def test_rename_code_excludes_itself_from_clash_check(self, mock_db):
        mock_db.get_item.return_value = global_item()
        mock_db.list_items.return_value = [global_item()]  # only itself, same code
        mock_db.update_item.return_value = global_item()

        resp = self.client.patch(f'/api/v1/catalogue-items/{ITEM_ID}/', {'code': 'REG-NEW'}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_clearing_centre_id_back_to_global_sends_explicit_null(self, mock_db):
        """Regression test for the bug where switching Availability to
        'Every centre (global)' silently left the old centre_id in place:
        the view must forward centreId:null through untouched — it's what
        tells DynamoDBService.update() to REMOVE the attribute rather than
        leave it alone (an absent key does nothing)."""
        mock_db.get_item.return_value = centre_item()
        mock_db.update_item.return_value = global_item()

        resp = self.client.patch(
            f'/api/v1/catalogue-items/{ITEM_ID}/', {'centreId': None}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sent_updates = mock_db.update_item.call_args[0][1]
        self.assertIn('centre_id', sent_updates)
        self.assertIsNone(sent_updates['centre_id'])

    def test_reassigning_to_a_different_centre(self, mock_db):
        mock_db.get_item.return_value = centre_item(centre_id=CENTRE_ID)
        mock_db.update_item.return_value = centre_item(centre_id=OTHER_CENTRE_ID)

        resp = self.client.patch(
            f'/api/v1/catalogue-items/{ITEM_ID}/', {'centreId': OTHER_CENTRE_ID}, format='json'
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sent_updates = mock_db.update_item.call_args[0][1]
        self.assertEqual(sent_updates['centre_id'], OTHER_CENTRE_ID)


# =============================================================================
# CatalogueItemViewSet: destroy
# =============================================================================

@patch('catalogue.views.catalogue_db')
class CatalogueItemDestroyTests(CatalogueAPITestCase):
    def test_destroy_success(self, mock_db):
        resp = self.client.delete(f'/api/v1/catalogue-items/{ITEM_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_db.delete_item.assert_called_once_with(ITEM_ID)


# =============================================================================
# DiscountRuleViewSet
# =============================================================================

@patch('catalogue.views.catalogue_db')
class DiscountRuleListRetrieveTests(CatalogueAPITestCase):
    def test_list_scoped_to_centre(self, mock_db):
        mock_db.list_discounts.return_value = [global_discount()]

        resp = self.client.get(f'/api/v1/discount-rules/?centre_id={CENTRE_ID}')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_db.list_discounts.assert_called_once_with(centre_id=CENTRE_ID, include_inactive=True)

    def test_retrieve_not_found(self, mock_db):
        mock_db.get_discount.return_value = None

        resp = self.client.get(f'/api/v1/discount-rules/{DISCOUNT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_found(self, mock_db):
        mock_db.get_discount.return_value = global_discount()

        resp = self.client.get(f'/api/v1/discount-rules/{DISCOUNT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['code'], 'SIBLING10')


@patch('catalogue.views.catalogue_db')
class DiscountRuleCreateTests(CatalogueAPITestCase):
    VALID_PAYLOAD = {'name': 'Early payment discount', 'code': 'EARLYBIRD', 'kind': 'percent', 'value': 5}

    def test_missing_name(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'name': ''}

        resp = self.client.post('/api/v1/discount-rules/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('name', resp.data)
        mock_db.create_discount.assert_not_called()

    def test_missing_code(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'code': ''}

        resp = self.client.post('/api/v1/discount-rules/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('code', resp.data)

    def test_value_zero_rejected(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'value': 0}

        resp = self.client.post('/api/v1/discount-rules/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('value', resp.data)
        mock_db.create_discount.assert_not_called()

    def test_percent_over_100_rejected(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'kind': 'percent', 'value': 150}

        resp = self.client.post('/api/v1/discount-rules/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('value', resp.data)
        mock_db.create_discount.assert_not_called()

    def test_flat_amount_over_100_is_allowed(self, mock_db):
        mock_db.create_discount.return_value = {'id': DISCOUNT_ID}
        payload = {'name': 'Referral credit', 'code': 'REFERRAL', 'kind': 'amount', 'value': 2000}

        resp = self.client.post('/api/v1/discount-rules/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_invalid_value_type_rejected(self, mock_db):
        payload = {**self.VALID_PAYLOAD, 'value': 'lots'}

        resp = self.client.post('/api/v1/discount-rules/', payload, format='json')

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('value', resp.data)

    def test_success(self, mock_db):
        mock_db.create_discount.return_value = {'id': DISCOUNT_ID, **self.VALID_PAYLOAD}

        resp = self.client.post('/api/v1/discount-rules/', self.VALID_PAYLOAD, format='json')

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_db.create_discount.assert_called_once()


@patch('catalogue.views.catalogue_db')
class DiscountRuleUpdateDestroyTests(CatalogueAPITestCase):
    def test_update_not_found(self, mock_db):
        mock_db.get_discount.return_value = None

        resp = self.client.patch(f'/api/v1/discount-rules/{DISCOUNT_ID}/', {'value': 15}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        mock_db.update_discount.assert_not_called()

    def test_update_success(self, mock_db):
        mock_db.get_discount.return_value = global_discount()
        mock_db.update_discount.return_value = {**global_discount(), 'value': 15}

        resp = self.client.patch(f'/api/v1/discount-rules/{DISCOUNT_ID}/', {'value': 15}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mock_db.update_discount.assert_called_once_with(DISCOUNT_ID, {'value': 15})

    def test_clearing_centre_id_sends_explicit_null(self, mock_db):
        mock_db.get_discount.return_value = {**global_discount(), 'centre_id': CENTRE_ID}
        mock_db.update_discount.return_value = global_discount()

        resp = self.client.patch(f'/api/v1/discount-rules/{DISCOUNT_ID}/', {'centreId': None}, format='json')

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        sent_updates = mock_db.update_discount.call_args[0][1]
        self.assertIn('centre_id', sent_updates)
        self.assertIsNone(sent_updates['centre_id'])

    def test_destroy_success(self, mock_db):
        resp = self.client.delete(f'/api/v1/discount-rules/{DISCOUNT_ID}/')

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        mock_db.delete_discount.assert_called_once_with(DISCOUNT_ID)
