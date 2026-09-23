from rest_framework import viewsets, status
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated

from schindia_auth.permissions import IsApprovedUser
from dynamo_backend.services import centres_db, sessions_db, children_db, roles_db
from roles.permissions_catalog import ALL_PERMISSION_KEYS
from roles.access import get_user_access, centre_not_found, permission_denied
from .serializers import CentreCreateSerializer, RoomSerializer


class CentreViewSet(viewsets.ViewSet):
    permission_classes = [IsAuthenticated, IsApprovedUser]
    serializer_class = CentreCreateSerializer

    def get_serializer(self, *args, **kwargs):
        kwargs['context'] = {'request': self.request}
        return CentreCreateSerializer(*args, **kwargs)

    def list(self, request, *args, **kwargs):
        access = get_user_access(request.user, request)
        accessible = access.accessible_centre_ids()
        centres = centres_db.list_centres()
        if accessible is not None:
            centres = [c for c in centres if c['id'] in accessible]
        return Response(centres)

    def retrieve(self, request, *args, **kwargs):
        centre_id = str(kwargs['pk'])
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        centre = centres_db.get_centre(centre_id)
        if not centre:
            return Response({'detail': 'Centre not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(centre)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data.copy()

        # Pop rooms — create them separately
        rooms_data = data.pop('rooms', [])
        centre = centres_db.create_centre(data)

        # Create rooms
        for room_data in rooms_data:
            centres_db.create_room(centre['id'], room_data)

        # Create default Admin role with every permission in the catalog (Req 15.4),
        # plus the admin-lockout keys ('people.manage'/'roles.manage' — see
        # roles/views.py admin_keys) which aren't part of the visible matrix
        # catalog but gate the roles/people-management endpoints.
        permissions = [
            {'key': key, 'edit': True, 'visible': True}
            for key in ALL_PERMISSION_KEYS
        ] + [
            {'key': key, 'edit': True, 'visible': True}
            for key in ('people.manage', 'roles.manage')
        ]
        role_data = {
            'name': 'Admin',
            'description': 'Full administrative access',
            'data_scope': 'all',
            'permissions': permissions,
        }
        role = roles_db.create_role(centre['id'], role_data)

        # Assign requesting user to admin role
        if request.user and request.user.is_authenticated:
            user_id = str(request.user.id)
            name = request.user.get_full_name() if hasattr(request.user, 'get_full_name') else ''
            email = request.user.email if hasattr(request.user, 'email') else ''
            roles_db.add_member(role['id'], user_id, name=name, email=email)

        # Refresh centre to include rooms
        centre = centres_db.get_centre(centre['id'])
        return Response(centre, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        centre_id = str(kwargs['pk'])
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'admin.configure_centre_settings'):
            return permission_denied()

        centre = centres_db.get_centre(centre_id)
        if not centre:
            return Response({'detail': 'Centre not found.'}, status=status.HTTP_404_NOT_FOUND)

        # Rooms live in their own DynamoDB table, not embedded on the centre item.
        # Reconcile the incoming array against it instead of letting it get
        # written straight onto the centre — that orphans it from the real
        # Rooms table, so any rooms added here vanish on the next fetch.
        if 'rooms' in request.data:
            error = self._reconcile_rooms(centre_id, request.data.get('rooms') or [])
            if error:
                return error

        # Validate through serializer (partial=True for PATCH)
        serializer = self.get_serializer(instance=centre, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        validated = serializer.validated_data.copy()
        validated.pop('rooms', None)
        updated = centres_db.update_centre(centre_id, validated)
        if not updated:
            return Response({'detail': 'Centre not found.'}, status=status.HTTP_404_NOT_FOUND)
        updated['rooms'] = centres_db.get_rooms(centre_id)
        return Response(updated)

    def _reconcile_rooms(self, centre_id, rooms_payload):
        """Create/rename/delete rooms so the Rooms table matches rooms_payload.

        Applies the same rules RoomViewSet enforces directly (name required,
        <=50 chars, unique per centre, deletion blocked while a room still has
        timetable slots) since this bypasses that viewset's per-room endpoints.
        Returns a Response on validation failure, or None on success.
        """
        existing = {r['id']: r for r in centres_db.get_rooms(centre_id)}
        incoming_ids = set()
        seen_names = set()

        for entry in rooms_payload:
            name = (entry.get('name') or '').strip()
            if not name:
                return Response({'rooms': ['Room name is required.']}, status=status.HTTP_400_BAD_REQUEST)
            if len(name) > 50:
                return Response({'rooms': ['Room name must be 50 characters or less.']}, status=status.HTTP_400_BAD_REQUEST)
            if name.lower() in seen_names:
                return Response({'rooms': [f'Duplicate room name: {name}']}, status=status.HTTP_400_BAD_REQUEST)
            seen_names.add(name.lower())

            room_id = entry.get('id')
            if room_id and room_id in existing:
                incoming_ids.add(room_id)
                if existing[room_id].get('name') != name:
                    centres_db.update_room(room_id, {'name': name})
            else:
                created = centres_db.create_room(centre_id, {'name': name})
                incoming_ids.add(created['id'])

        for room_id, room in existing.items():
            if room_id in incoming_ids:
                continue
            if sessions_db.list_slots_by_room(room_id):
                return Response(
                    {'rooms': [f'Cannot remove room "{room.get("name")}" because it is assigned to timetable entries.']},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            centres_db.delete_room(room_id)

        return None

    def destroy(self, request, *args, **kwargs):
        centre_id = str(kwargs['pk'])
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_id):
            return centre_not_found()
        if not access.can_edit(centre_id, 'admin.configure_centre_settings'):
            return permission_denied()

        centre = centres_db.get_centre(centre_id)
        if not centre:
            return Response({'detail': 'Centre not found.'}, status=status.HTTP_404_NOT_FOUND)

        # Block deletion if centre has dependent data
        children = [c for c in children_db.list_children(centre_id)]
        if children:
            return Response(
                {'detail': 'Cannot delete centre with enrolled children. Remove all children first.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        roles = roles_db.list_roles(centre_id)
        has_members = any(r.get('members') for r in roles)
        if has_members:
            return Response(
                {'detail': 'Cannot delete centre with active role members. Remove all members first.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Safe to delete — clean up rooms and empty roles
        for room in centre.get('rooms', []):
            centres_db.delete_room(room['id'])
        for role in roles:
            roles_db.delete_role(role['id'])

        centres_db.delete_centre(centre_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RoomViewSet(viewsets.ViewSet):
    permission_classes = [IsAuthenticated, IsApprovedUser]
    serializer_class = RoomSerializer

    def list(self, request, *args, **kwargs):
        centre_pk = str(kwargs['centre_pk'])
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_pk):
            return centre_not_found()
        if not access.can_view(centre_pk, 'admin.manage_departments_rooms'):
            return permission_denied()
        rooms = centres_db.get_rooms(centre_pk)
        return Response(rooms)

    def retrieve(self, request, *args, **kwargs):
        centre_pk = str(kwargs['centre_pk'])
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_pk):
            return centre_not_found()
        if not access.can_view(centre_pk, 'admin.manage_departments_rooms'):
            return permission_denied()
        room = centres_db.get_room(str(kwargs['pk']))
        if not room or room.get('centre_id') != centre_pk:
            return Response({'detail': 'Room not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(room)

    def create(self, request, *args, **kwargs):
        centre_pk = str(kwargs['centre_pk'])
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_pk):
            return centre_not_found()
        if not access.can_edit(centre_pk, 'admin.add_rooms'):
            return permission_denied()

        data = request.data.copy()

        # Validate room name
        name = data.get('name', '').strip()
        if not name:
            return Response(
                {'name': ['Room name is required.']},
                status=status.HTTP_400_BAD_REQUEST
            )
        if len(name) > 50:
            return Response(
                {'name': ['Room name must be 50 characters or less.']},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Check name uniqueness within centre
        existing_rooms = centres_db.get_rooms(centre_pk)
        for r in existing_rooms:
            if r.get('name', '').lower() == name.lower():
                return Response(
                    {'name': ['A room with this name already exists at this centre.']},
                    status=status.HTTP_400_BAD_REQUEST
                )

        data['name'] = name
        room = centres_db.create_room(centre_pk, data)
        return Response(room, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        centre_pk = str(kwargs['centre_pk'])
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_pk):
            return centre_not_found()
        if not access.can_edit(centre_pk, 'admin.edit_rooms'):
            return permission_denied()

        data = request.data.copy()

        # Validate room name if provided
        name = data.get('name')
        if name is not None:
            name = name.strip()
            if not name:
                return Response(
                    {'name': ['Room name is required.']},
                    status=status.HTTP_400_BAD_REQUEST
                )
            if len(name) > 50:
                return Response(
                    {'name': ['Room name must be 50 characters or less.']},
                    status=status.HTTP_400_BAD_REQUEST
                )
            # Check uniqueness within centre
            existing_rooms = centres_db.get_rooms(centre_pk)
            for r in existing_rooms:
                if r.get('id') != str(kwargs['pk']) and r.get('name', '').lower() == name.lower():
                    return Response(
                        {'name': ['A room with this name already exists at this centre.']},
                        status=status.HTTP_400_BAD_REQUEST
                    )
            data['name'] = name

        room = centres_db.update_room(str(kwargs['pk']), data)
        if not room:
            return Response({'detail': 'Room not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(room)

    def destroy(self, request, *args, **kwargs):
        """Prevent removal of rooms with timetable assignments (Req 5.7)."""
        centre_pk = str(kwargs['centre_pk'])
        access = get_user_access(request.user, request)
        if not access.can_access_centre(centre_pk):
            return centre_not_found()
        if not access.can_edit(centre_pk, 'admin.delete_rooms'):
            return permission_denied()

        room_id = str(kwargs['pk'])
        # Use room_id-index for efficient lookup instead of scanning all centre slots
        room_slots = sessions_db.list_slots_by_room(room_id)
        if room_slots:
            return Response(
                {'detail': 'Cannot remove this room because it is assigned to timetable entries.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        centres_db.delete_room(room_id)
        return Response(status=status.HTTP_204_NO_CONTENT)
