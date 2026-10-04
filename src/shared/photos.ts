/**
 * A document's photos, cover first, plus `image` (the cover) for views that show one. Older documents
 * only have the single `image` field; they read as a one-photo gallery.
 */
export function photos(doc: { image?: string; images?: string[] }) {
  const images = doc.images ?? (doc.image ? [doc.image] : []);
  return { images, image: images[0] };
}
