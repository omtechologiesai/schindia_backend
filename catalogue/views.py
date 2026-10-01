from enum import Enum

from rest_framework import viewsets, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from schindia_auth.permissions import IsApprovedUser
from dynamo_backend.services import catalogue_db


class ProductUnit(str, Enum):
    PER_MONTH = 'per month'
    PER_SESSION = 'per session'


PRODUCT_UNITS = [u.value for u in ProductUnit]
UNIT_ERROR = {'unit': [f"Unit must be one of: {', '.join(PRODUCT_UNITS)}."]}


class CatalogueItemViewSet(viewsets.ViewSet):
    """
    Product catalogue, viewed per centre: the global sheet plus whatever that
    centre added locally.

    GET  /catalogue-items/?centre_id=<id>   list of global + that centre's items (omit for global-only)
    POST /catalogue-items/                  body may include centre_id — omitted/blank means global
    """
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        centre_id = request.query_params.get('centre_id') or None
        include_inactive = request.query_params.get('include_inactive', 'true').lower() != 'false'
        return Response(catalogue_db.list_items(centre_id=centre_id, include_inactive=include_inactive))

    def retrieve(self, request, *args, **kwargs):
        item = catalogue_db.get_item(str(kwargs['pk']))
        if not item:
            return Response({'detail': 'Product not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(item)

    def create(self, request, *args, **kwargs):
        data = request.data.copy()
        error = _validate_item(data)
        if error:
            return Response(error, status=status.HTTP_400_BAD_REQUEST)

        clash = self._code_clash(data.get('code'), data.get('centre_id'))
        if clash:
            return Response({'code': ['Another product already uses that code.']}, status=status.HTTP_400_BAD_REQUEST)

        item = catalogue_db.create_item(data)
        return Response(item, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        item = catalogue_db.get_item(str(kwargs['pk']))
        if not item:
            return Response({'detail': 'Product not found.'}, status=status.HTTP_404_NOT_FOUND)

        data = request.data.copy()
        # An older product may keep the unit it already has; any change must be to a listed unit.
        if 'unit' in data and data['unit'] not in PRODUCT_UNITS and data['unit'] != item.get('unit'):
            return Response(UNIT_ERROR, status=status.HTTP_400_BAD_REQUEST)
        if 'code' in data:
            clash = self._code_clash(data.get('code'), data.get('centre_id', item.get('centre_id')), exclude_id=item['id'])
            if clash:
                return Response({'code': ['Another product already uses that code.']}, status=status.HTTP_400_BAD_REQUEST)

        updated = catalogue_db.update_item(str(kwargs['pk']), data)
        return Response(updated)

    def destroy(self, request, *args, **kwargs):
        catalogue_db.delete_item(str(kwargs['pk']))
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _code_clash(self, code, centre_id, exclude_id=None):
        if not code:
            return False
        rows = catalogue_db.list_items(centre_id=centre_id, include_inactive=True)
        return any(
            r['id'] != exclude_id and r.get('code', '').upper() == code.strip().upper()
            for r in rows
        )


class DiscountRuleViewSet(viewsets.ViewSet):
    """Discount & affiliate rules, scoped the same way as catalogue items."""
    permission_classes = [IsAuthenticated, IsApprovedUser]

    def list(self, request, *args, **kwargs):
        centre_id = request.query_params.get('centre_id') or None
        include_inactive = request.query_params.get('include_inactive', 'true').lower() != 'false'
        return Response(catalogue_db.list_discounts(centre_id=centre_id, include_inactive=include_inactive))

    def retrieve(self, request, *args, **kwargs):
        rule = catalogue_db.get_discount(str(kwargs['pk']))
        if not rule:
            return Response({'detail': 'Discount not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(rule)

    def create(self, request, *args, **kwargs):
        data = request.data.copy()
        error = _validate_discount(data)
        if error:
            return Response(error, status=status.HTTP_400_BAD_REQUEST)
        rule = catalogue_db.create_discount(data)
        return Response(rule, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        rule = catalogue_db.get_discount(str(kwargs['pk']))
        if not rule:
            return Response({'detail': 'Discount not found.'}, status=status.HTTP_404_NOT_FOUND)
        updated = catalogue_db.update_discount(str(kwargs['pk']), request.data.copy())
        return Response(updated)

    def destroy(self, request, *args, **kwargs):
        catalogue_db.delete_discount(str(kwargs['pk']))
        return Response(status=status.HTTP_204_NO_CONTENT)


def _validate_item(data):
    if not (data.get('name') or '').strip():
        return {'name': ['Give the product a name.']}
    if not (data.get('code') or '').strip():
        return {'code': ['Give the product a short code.']}
    try:
        if float(data.get('price', 0)) <= 0:
            return {'price': ['Enter a price greater than zero.']}
    except (TypeError, ValueError):
        return {'price': ['Enter a valid price.']}
    data.setdefault('category', 'other')
    data.setdefault('unit', ProductUnit.PER_MONTH.value)
    if data['unit'] not in PRODUCT_UNITS:
        return UNIT_ERROR
    return None


def _validate_discount(data):
    if not (data.get('name') or '').strip():
        return {'name': ['Give the discount a name.']}
    if not (data.get('code') or '').strip():
        return {'code': ['Give the discount a short code.']}
    try:
        value = float(data.get('value', 0))
    except (TypeError, ValueError):
        return {'value': ['Enter a valid value.']}
    if value <= 0:
        return {'value': ['Enter a value greater than zero.']}
    if data.get('kind', 'percent') == 'percent' and value > 100:
        return {'value': ['A percentage discount cannot exceed 100%.']}
    return None
