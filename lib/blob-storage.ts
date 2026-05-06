import { del, put } from "@vercel/blob";

export function proofPathname(claimId: string): string {
  return `wealth-proof/v1/${claimId}.json`;
}

export function isBlobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

export async function putProofJson(
  claimId: string,
  jsonUtf8: string
): Promise<{ url: string; pathname: string }> {
  const pathname = proofPathname(claimId);
  const result = await put(pathname, jsonUtf8, {
    access: "public",
    contentType: "application/json; charset=utf-8",
    addRandomSuffix: false,
  });
  return { url: result.url, pathname: result.pathname };
}

export async function deleteProofBlob(blobUrl: string): Promise<void> {
  await del(blobUrl);
}
