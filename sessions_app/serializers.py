from datetime import date as date_type

from rest_framework import serializers

from dynamo_backend.services.sessions_service import DEFAULT_CHILD_LIMIT


class SessionSerializer(serializers.Serializer):
    id = serializers.CharField(read_only=True)
    centre = serializers.CharField(source='centre_id', required=False)
    name = serializers.CharField(max_length=50)
    child_limit = serializers.IntegerField(default=DEFAULT_CHILD_LIMIT)
    age_from = serializers.IntegerField(default=0)
    age_to = serializers.IntegerField(default=5)
    age_unit = serializers.ChoiceField(choices=['months', 'years'], default='years')
    duration_hours = serializers.IntegerField(default=1)
    duration_minutes = serializers.IntegerField(default=30)
    color_bg = serializers.CharField(read_only=True)
    color_text = serializers.CharField(read_only=True)
    enrolled_count = serializers.SerializerMethodField()
    duration_display = serializers.SerializerMethodField()
    age_range_display = serializers.SerializerMethodField()
    created_at = serializers.CharField(read_only=True)

    def get_enrolled_count(self, obj):
        return len(obj.get('child_ids', [])) if isinstance(obj, dict) else 0

    def get_duration_display(self, obj):
        """Human-readable duration like '1hr 30min' or '2hr'."""
        hours = obj.get('duration_hours', 0)
        minutes = obj.get('duration_minutes', 0)
        parts = []
        if hours:
            parts.append(f"{hours}hr")
        if minutes:
            parts.append(f"{minutes}min")
        return ' '.join(parts) or '0min'

    def get_age_range_display(self, obj):
        """Human-readable age range like '0–12 months' or '2–3 years'."""
        return f"{obj.get('age_from', 0)}–{obj.get('age_to', 5)} {obj.get('age_unit', 'years')}"


class SessionSlotSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    centre = serializers.CharField(source='centre_id', required=False)
    room = serializers.CharField(source='room_id', required=False)
    session = serializers.CharField(source='session_id', required=False)
    day = serializers.ChoiceField(choices=['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
    start_time = serializers.CharField()
    booking_type = serializers.ChoiceField(choices=['one-off', 'recurring'])
    start_date = serializers.CharField()
    end_date = serializers.CharField(required=False, allow_null=True)
    starting_month = serializers.IntegerField(default=1)
    starting_week = serializers.IntegerField(default=1)
    teacher_ids = serializers.ListField(child=serializers.UUIDField(), required=False)
    child_ids = serializers.ListField(child=serializers.UUIDField(), required=False)
    notes = serializers.CharField(required=False, allow_blank=True)
    session_name = serializers.CharField(read_only=True)
    room_name = serializers.CharField(read_only=True)
    children_count = serializers.SerializerMethodField()
    duration_total_minutes = serializers.IntegerField(read_only=True)
    child_limit = serializers.IntegerField(read_only=True)
    color_bg = serializers.CharField(read_only=True)
    color_text = serializers.CharField(read_only=True)
    created_at = serializers.CharField(read_only=True)

    def get_children_count(self, obj):
        return len(obj.get('child_ids', [])) if isinstance(obj, dict) else 0


class SlotAttendanceMarkSerializer(serializers.Serializer):
    child_id = serializers.UUIDField()
    date = serializers.DateField()
    status = serializers.ChoiceField(choices=['present', 'absent'])

    def validate_date(self, value):
        if value > date_type.today():
            raise serializers.ValidationError('Cannot record attendance for a future date.')
        return value


class GenerateSlotsSerializer(serializers.Serializer):
    session_id = serializers.CharField()
    room_id = serializers.UUIDField()
    start_time = serializers.TimeField()
    booking_type = serializers.ChoiceField(choices=['one-off', 'recurring'])
    start_date = serializers.DateField()
    starting_month = serializers.IntegerField(default=1)
    starting_week = serializers.IntegerField(default=1)
    teacher_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    child_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    notes = serializers.CharField(required=False, default='', allow_blank=True)
