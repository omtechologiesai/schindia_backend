from django.urls import path
from rest_framework.routers import DefaultRouter
from . import views

router = DefaultRouter()

# Standalone slot endpoints (for PATCH/DELETE by ID)
router.register(r'slots', views.SessionSlotViewSet, basename='slot-standalone')

urlpatterns = [
    # Sessions — static registry, read + per-centre config only
    path(
        'centres/<uuid:centre_pk>/sessions/',
        views.SessionViewSet.as_view({'get': 'list'}),
        name='centre-sessions-list'
    ),
    path(
        'centres/<uuid:centre_pk>/sessions/<str:pk>/',
        views.SessionViewSet.as_view({'get': 'retrieve', 'patch': 'update'}),
        name='centre-sessions-detail'
    ),
    # Slots
    path(
        'centres/<uuid:centre_pk>/slots/',
        views.SessionSlotViewSet.as_view({'get': 'list', 'post': 'create'}),
        name='centre-slots-list'
    ),
    path(
        'centres/<uuid:centre_pk>/slots/<uuid:pk>/',
        views.SessionSlotViewSet.as_view({'get': 'retrieve', 'patch': 'partial_update', 'delete': 'destroy'}),
        name='centre-slots-detail'
    ),
    path(
        'centres/<uuid:centre_pk>/slots/generate/',
        views.generate_slots,
        name='centre-slots-generate'
    ),
    path(
        'centres/<uuid:centre_pk>/slots/<uuid:slot_pk>/attendance/',
        views.slot_attendance,
        name='centre-slot-attendance'
    ),
    path(
        'centres/<uuid:centre_pk>/slots/<uuid:slot_pk>/attendance/mark/',
        views.mark_slot_attendance,
        name='centre-slot-attendance-mark'
    ),
    path(
        'centres/<uuid:centre_pk>/timetable/',
        views.timetable,
        name='centre-timetable'
    ),
] + router.urls
