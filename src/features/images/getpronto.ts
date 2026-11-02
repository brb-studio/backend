import * as z from "zod";

const API = "https://api.getpronto.io/v1";
const TIMEOUT_MS = 15_000;

const presigned = z.object({
  uploadUrl: z.url({ protocol: /^https$/ }),
  pendingUploadId: z.string().min(1),
});
const confirmed = z.object({
  file: z.object({
    id: z.string().min(1),
    secureUrl: z.url({ protocol: /^https$/ }).max(500),
  }),
});

const unwrap = (body: unknown) =>
  typeof body === "object" && body !== null && "data" in body
    ? body.data
    : body;

export async function storeInGetPronto(
  apiKey: string,
  image: {
    folder: string;
    name: string;
    contentType: string;
    bytes: Uint8Array;
  },
) {
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Get Pronto ${path} answered ${res.status}`);
    return unwrap(await res.json());
  };

  const { uploadUrl, pendingUploadId } = presigned.parse(
    await call("/upload/presign", {
      filename: image.name,
      customFilename: image.name,
      folderName: image.folder,
      mimetype: image.contentType,
      size: image.bytes.length,
    }),
  );
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": image.contentType },
    body: image.bytes,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!put.ok) throw new Error(`Get Pronto storage answered ${put.status}`);
  const { file } = confirmed.parse(
    await call("/upload/confirm", { pendingUploadId }),
  );
  return { id: file.id, url: file.secureUrl };
}
