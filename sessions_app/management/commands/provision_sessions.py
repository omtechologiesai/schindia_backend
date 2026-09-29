"""
Create each centre's session rows for centres that existed before rows were
provisioned at centre creation. Safe to re-run.

Usage: python manage.py provision_sessions
"""

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Create the catalogue session rows for every existing centre that is missing them"

    def handle(self, *args, **options):
        from dynamo_backend.services import centres_db, sessions_db

        for centre in centres_db.list_centres():
            before = len(sessions_db.list_sessions(centre['id']))
            sessions_db.provision_centre_sessions(centre['id'])
            after = len(sessions_db.list_sessions(centre['id']))
            self.stdout.write(f"  ✓ {centre.get('name', centre['id'])}: {after - before} created, {after} total")

        self.stdout.write(self.style.SUCCESS('Done.'))
