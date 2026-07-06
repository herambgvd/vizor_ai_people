"""people-analytics domain — cameras + analytics events

Revision ID: 0004_people_cameras_events
Revises: 0003_email_templates
Create Date: 2026-07-06

Creates the first people-analytics domain tables: ``pa_cameras`` (RTSP sources +
per-scenario config) and ``pa_events`` (crowd / counting / loitering / intrusion
alerts). Uses metadata.create_all(checkfirst) so only the new tables are created.
"""

from alembic import op

revision = "0004_people_cameras_events"
down_revision = "0003_email_templates"
branch_labels = None
depends_on = None


def _metadata():
    # Import inside the function so the models register on Base.metadata at run time.
    from edge.db.base import Base
    import app.domain.models  # noqa: F401 — registers pa_cameras + pa_events

    return Base.metadata


def upgrade() -> None:
    # checkfirst=True (create_all default) → creates only the not-yet-present tables.
    _metadata().create_all(op.get_bind())


def downgrade() -> None:
    op.drop_table("pa_events")
    op.drop_table("pa_cameras")
