from rest_framework import serializers


class ContactSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(max_length=150)
    relation = serializers.CharField(max_length=50)
    phone = serializers.CharField(max_length=30)
    email = serializers.EmailField()
    invite_as = serializers.ChoiceField(
        choices=["Don't invite", 'Parent', 'Guardian', 'Carer'], default='Parent'
    )
    is_main = serializers.BooleanField(default=False)
    is_bill_payer = serializers.BooleanField(default=False)
    is_emergency = serializers.BooleanField(default=False)

    def validate(self, data):
        is_main = data.get('is_main', False)
        if is_main:
            if not data.get('name'):
                raise serializers.ValidationError({'name': 'Name is required for main contact.'})
            if not data.get('email'):
                raise serializers.ValidationError({'email': 'Email is required for main contact.'})
            if not data.get('phone'):
                raise serializers.ValidationError({'phone': 'Phone is required for main contact.'})
            if not data.get('relation'):
                raise serializers.ValidationError({'relation': 'Relation is required for main contact.'})
        return data


class ChildListSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    system_id = serializers.CharField(read_only=True)
    first_name = serializers.CharField(max_length=100)
    middle_name = serializers.CharField(max_length=100, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=100)
    gender = serializers.ChoiceField(choices=['Male', 'Female', 'Other', 'Prefer not to say'])
    centre = serializers.CharField(source='centre_id', required=False)
    centre_name = serializers.CharField(read_only=True, default='')
    session = serializers.CharField(source='session_id', required=False, allow_null=True)
    session_name = serializers.CharField(read_only=True, default=None)
    date_of_birth = serializers.DateField()
    start_date = serializers.DateField()
    sibling = serializers.CharField(source='sibling_id', required=False, allow_null=True)
    contacts = ContactSerializer(many=True, required=False)
    age_display = serializers.SerializerMethodField()
    course_progress = serializers.SerializerMethodField()
    status = serializers.SerializerMethodField()
    created_at = serializers.CharField(read_only=True)

    def get_age_display(self, obj):
        from datetime import date, datetime
        from dateutil.relativedelta import relativedelta
        dob = obj.get('date_of_birth')
        if isinstance(dob, str):
            dob = datetime.strptime(dob, '%Y-%m-%d').date()
        today = date.today()
        rd = relativedelta(today, dob)
        years = rd.years
        months = rd.months
        if years > 0:
            parts = [f"{years} year{'s' if years != 1 else ''}"]
            if months > 0:
                parts.append(f"{months} month{'s' if months != 1 else ''}")
            return ', '.join(parts)
        return f"{months} month{'s' if months != 1 else ''}"

    def get_course_progress(self, obj):
        from dynamo_backend.services import progress_db
        progress = progress_db.get_course_progress(str(obj.get('id', '')))
        return (progress or {}).get('display', 'M1 W1')

    def get_status(self, obj):
        """Active if child has a current enrolment (end_date >= today or no end_date)."""
        from datetime import date
        from dynamo_backend.services import children_db
        if not obj.get('session_id'):
            return 'Inactive'
        today = date.today().isoformat()
        enrolments = children_db.list_enrolments(str(obj.get('id', '')))
        if not enrolments:
            return 'Active'
        active_enrolment = any((e.get('end_date') or '') >= today for e in enrolments)
        return 'Active' if active_enrolment else 'Inactive'


class ChildCreateSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    system_id = serializers.CharField(read_only=True)
    first_name = serializers.CharField(max_length=100)
    middle_name = serializers.CharField(max_length=100, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=100)
    gender = serializers.ChoiceField(choices=['Male', 'Female', 'Other', 'Prefer not to say'])
    centre = serializers.CharField(source='centre_id', required=False)
    session = serializers.CharField(source='session_id', required=False, allow_null=True)
    date_of_birth = serializers.DateField()
    start_date = serializers.DateField()
    sibling = serializers.CharField(source='sibling_id', required=False, allow_null=True)
    contacts = ContactSerializer(many=True, required=False)

    def validate(self, data):
        from datetime import date
        contacts = data.get('contacts', [])
        # At least one main contact required on creation
        if self.instance is None:  # Only on create
            has_main = any(c.get('is_main', False) for c in contacts)
            if contacts and not has_main:
                raise serializers.ValidationError(
                    {'contacts': 'At least one contact must be marked as main.'}
                )

        # date_of_birth must not be in the future
        dob = data.get('date_of_birth')
        if dob and dob > date.today():
            raise serializers.ValidationError(
                {'date_of_birth': 'Date of birth cannot be in the future.'}
            )

        # start_date must be on or after date_of_birth
        start_date = data.get('start_date')
        if dob and start_date and start_date < dob:
            raise serializers.ValidationError(
                {'start_date': 'Start date cannot be before date of birth.'}
            )

        return data


class ChildEnrolmentSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    child = serializers.CharField(source='child_id', required=False)
    slot = serializers.CharField(source='slot_id', required=False)
    start_date = serializers.DateField()
    end_date = serializers.DateField()
    session_name = serializers.CharField(read_only=True)
    room_name = serializers.CharField(read_only=True)
    day = serializers.CharField(read_only=True)
    start_time = serializers.CharField(read_only=True)
    created_at = serializers.CharField(read_only=True)
    # Set when the place was given up. Distinct from end_date, which is when
    # the booking was always going to finish — a completed term is not a
    # cancellation.
    cancelled_at = serializers.CharField(read_only=True, required=False)
