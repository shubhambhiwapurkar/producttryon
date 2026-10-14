"""Create a store (a client jeweller) and print its page links.

Usage: python -m scripts.create_store <slug> "<Store name>" [--whatsapp "+91..."] [--website https://...]
"""

import argparse
import re
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db

# The slug appears in URLs and in media folder names, so keep it simple and safe.
SLUG_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")


class StoreError(ValueError):
    """A store could not be created."""


def create_store_record(
    session: Session,
    slug: str,
    name: str,
    whatsapp: str | None = None,
    website: str | None = None,
) -> db.Store:
    """Insert a new store and commit it. Raises StoreError if the slug is invalid or taken."""
    if not SLUG_PATTERN.fullmatch(slug):
        raise StoreError("slug may only contain lowercase letters, digits and hyphens")
    if not name.strip():
        raise StoreError("store name cannot be empty")
    if session.scalar(select(db.Store.id).where(db.Store.slug == slug)) is not None:
        raise StoreError(f"a store with slug '{slug}' already exists")
    store = db.Store(slug=slug, name=name.strip(), whatsapp_number=whatsapp, website_url=website)
    session.add(store)
    session.commit()
    return store


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a store and print its customer and admin links.")
    parser.add_argument("slug", help="URL-safe identifier, e.g. sharma-jewellers")
    parser.add_argument("name", help="Store name shown to customers")
    parser.add_argument("--whatsapp", help='WhatsApp number, e.g. "+91..."')
    parser.add_argument("--website", help="Store website URL")
    args = parser.parse_args()

    db.init_db()
    try:
        with db.SessionLocal() as session:
            store = create_store_record(session, args.slug, args.name, args.whatsapp, args.website)
    except StoreError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Store:          {store.name}")
    print(f"Store slug:     {store.slug}")
    print(f"Customer page:  /s/{store.slug}")
    print(f"Admin page:     /admin/{store.slug}")
    print(f"Admin token:    {store.admin_token}")


if __name__ == "__main__":
    main()
