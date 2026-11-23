async function through(
  bytes: Uint8Array<ArrayBuffer>,
  stream: TransformStream<Uint8Array, Uint8Array>,
) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const gzip = (text: string) =>
  through(new Uint8Array(new TextEncoder().encode(text)), new CompressionStream("gzip"));

export const gunzip = async (bytes: Uint8Array<ArrayBuffer>) =>
  new TextDecoder().decode(await through(bytes, new DecompressionStream("gzip")));

/** A graph's text as the database keeps it: gzipped, in base64. */
export const gzipBase64 = async (text: string) => Buffer.from(await gzip(text)).toString("base64");
