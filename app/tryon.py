"""Runs a try-on job and cleans up expired customer photos."""

import logging
from datetime import timedelta

from sqlalchemy import select

from . import config, db
from .imaging import delete_media, load_image, read_media, save_image, to_jpeg, watermark
from .renderers import RenderRequest, get_renderer

log = logging.getLogger(__name__)


def run_tryon(tryon_id: str, renderer_name: str | None = None) -> None:
    with db.SessionLocal() as session:
        job = session.get(db.TryOn, tryon_id)
        if job is None or job.status != "queued":
            return
        job.status = "running"
        session.commit()

        try:
            product = session.get(db.Product, job.product_id) if job.product_id else None
            if product is not None:
                image_paths = [img.path for img in product.images]
                details = " ".join(filter(None, [product.dimensions, product.description]))
                name = product.name
            else:
                image_paths, details, name = job.custom_image_paths or [], None, None
            if not image_paths:
                raise ValueError("No product photos to try on")

            renderer = get_renderer(renderer_name)
            req = RenderRequest(
                category=job.category,
                person=load_image(read_media(job.selfie_path)),
                product_images=[load_image(read_media(p)) for p in image_paths[: config.MAX_PRODUCT_IMAGES]],
                product_name=name,
                product_details=details or None,
            )
            result = watermark(renderer.render(req))
            job.result_path = save_image(to_jpeg(result, 92), f"tryons/{job.id}", max_side=2048)
            job.renderer = renderer.name
            job.status = "done"
        except Exception as exc:  # surfaced to the customer as "failed"
            log.exception("try-on %s failed", tryon_id)
            job.status = "failed"
            job.error = str(exc)[:500]
        job.finished_at = db.utcnow()
        session.commit()


def purge_expired(session) -> int:
    """Delete customer photos and results older than RETENTION_DAYS."""
    cutoff = db.utcnow() - timedelta(days=config.RETENTION_DAYS)
    old = session.scalars(select(db.TryOn).where(db.TryOn.created_at < cutoff)).all()
    for job in old:
        for path in [job.selfie_path, job.result_path, *(job.custom_image_paths or [])]:
            delete_media(path)
        session.delete(job)
    session.commit()
    return len(old)
