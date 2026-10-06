// ABOUTME: Проверяет установщик на отдельной acceptance-БД и собственных case-каталогах.
// ABOUTME: Живой запуск требует REQUIRED=1, принятую DB identity, фазу и границы wrapper.
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { validateMetadataEvent, validateSchema } from '../../contracts/index.mjs';
import { supportedProfiles } from '../../src/main.mjs';
import { createHuggingFaceCatalog, createModelInstaller, registerSupportedProfiles } from '../../dist/install/huggingface.js';
import { createPostgresStore } from '../../dist/storage/postgres.js';
import {
  assertFreshInstallNamespace,
  assertInstallDatabaseIdentity,
  installAcceptanceCaseDirectories,
  isNativeEnospcWitness,
  readInstallAcceptanceConfig,
  withNativeEnospcWitness,
} from './install-acceptance-helper.mjs';

const REQUIRED = process.env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_REQUIRED === '1';
const MODEL_ID = 'gigaam-v3-e2e-ctc';
const PROFILE_ID = 'gigaam_pytorch';
const REPOSITORY = 'ai-sage/GigaAM-v3';
const REVISION = 'cec030b4c4f35d928e4a9044a3bdb29ebd499fac';
const TOTAL_BYTES = 442_696_950;
const MAX_ATTEMPT_MS = 900_000;
const TMPFS_MAGIC = 0x01021994;
const { Pool } = pg;

test('protected real installer acceptance uses only isolated fixture resources', { timeout: MAX_ATTEMPT_MS, skip: !REQUIRED && 'run only through the protected Ansible wrapper with REQUIRED=1' }, async t => {
  t.diagnostic('BODY_ENTERED');
  let pool;
  let installer;
  let errorCode = null;
  let releaseFetchBarrier;
  const startedAt = Date.now();
  const receipt = { bodyEntered: true, identityVerified: false, nativeEnospcObserved: false, progressMonotonic: false, progressIntermediate: false };
  try {
    const config = readInstallAcceptanceConfig(process.env);
    receipt.phase = config.phase;
    receipt.maxOperationMs = config.maxOperationMs;
    check(config.watchdogMs === MAX_ATTEMPT_MS, 'TEST_TIMEOUT_MATCHES_WATCHDOG');
    const profile = chooseAcceptedProfile();
    const files = profile.files;
    const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    check(files.length === 4 && totalBytes === TOTAL_BYTES, 'PINNED_MANIFEST');
    receipt.manifestFiles = files.length;
    receipt.manifestBytes = totalBytes;

    pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 5_000, statement_timeout: config.maxOperationMs });
    const identity = (await pool.query('SELECT current_database() AS database,current_user AS role')).rows[0];
    assertInstallDatabaseIdentity(identity);
    receipt.identityVerified = true;

    const directories = installAcceptanceCaseDirectories(config);
    await assertRunDirectory(directories.root);
    await assertRunDirectory(directories.publicDirectory);
    await assertRunDirectory(directories.hashCandidateDirectory);
    await assertRunDirectory(directories.enospcDirectory);

    const store = createPostgresStore(pool, { outboxCapacity: 8, queryTimeoutMs: 5_000 });
    await assertPhaseDatabaseState(pool, store, profile, config);
    if (config.phase === 'hash') await registerSupportedProfiles(store, [profile]);

    if (config.phase === 'hash') {
      await assertHashCandidate(directories.hashCandidateDirectory, profile);
      const before = await readAcceptanceState(pool, store, profile, config.runId);
      installer = createInstaller(store, profile, directories.hashCandidateDirectory, config.maxOperationMs, files, realPublicFetch);
      const mismatch = await safeOutcome(() => installer.importVerified({
        modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId,
        directory: path.join(directories.hashCandidateDirectory, profile.modelId, profile.revision, profile.profileId),
      }));
      check(mismatch === 'REVISION_CONFLICT', 'HASH_MISMATCH_REJECTED');
      const after = await readAcceptanceState(pool, store, profile, config.runId);
      check(sameAcceptanceCounts(before, after), 'HASH_REJECTION_NO_DB_CHANGE');
      check(after.installations.length === 0 && after.operations.length === 0, 'HASH_REJECTION_NOT_READY');
      receipt.hashCandidateVerifiedFiles = files.length;
      receipt.hashMismatchRejected = true;
      receipt.databaseChangesOnHashMismatch = 0;
    } else if (config.phase === 'enospc') {
      await assertEnospcMount(directories.enospcDirectory);
      const before = await readAcceptanceState(pool, store, profile, config.runId);
      check(before.installations.length === 0 && before.operations.length === 0, 'ENOSPC_PHASE_BASELINE');
      installer = createInstaller(store, profile, directories.enospcDirectory, config.maxOperationMs, files, realPublicFetch);
      const witness = await withNativeEnospcWitness(directories.enospcDirectory, async () => {
        const request = installRequest(profile, config.runId, phaseRequestId(config.runId, 'enospc'), config.maxOperationMs);
        await installer.start(request);
        await waitForTerminal(installer, request.requestId, request.ownerId, config.maxOperationMs);
        await installer.close();
        installer = null;
      });
      check(isNativeEnospcWitness(witness.observed) && witness.observed.errno === -28, 'NATIVE_ENOSPC_WRITE_OBSERVED');
      receipt.nativeEnospcObserved = isNativeEnospcWitness(witness.observed) && witness.observed.errno === -28;
      receipt.nativeWriteError = receipt.nativeEnospcObserved ? { code: witness.observed.code, errno: witness.observed.errno, syscall: witness.observed.syscall } : null;
      receipt.nativeWriteCalls = witness.observed.writeCalls;
      check(witness.thrown === undefined, 'INSTALLER_TERMINATED_WITH_SAFE_STATUS');
      const operation = await store.transaction(tx => tx.installationOperations.get(phaseRequestId(config.runId, 'enospc'), config.runId));
      check(operation?.status === 'failed' && operation.errorCode === 'INSTALLATION_FAILED', 'ENOSPC_TERMINAL_FAILED');
      const after = await readAcceptanceState(pool, store, profile, config.runId);
      check(after.installations.length === 0, 'ENOSPC_NO_INSTALLATION');
      check(after.status.reserved === 0, 'ENOSPC_TERMINAL_RESERVATION_CLOSED');
      await assertNoFinalOrStagingDirectory(directories.enospcDirectory, profile, operation.operationId);
      receipt.failedOperation = true;
      receipt.installationsAfterEnospc = after.installations.length;
      receipt.reservedAfterEnospc = after.status.reserved;
      receipt.failedOperationStatus = operation.status;
    } else if (config.phase === 'public') {
      await assertPublicFilesystem(directories.publicDirectory, totalBytes + config.publicReserveBytes);
      const previousFailure = await store.transaction(tx => tx.installationOperations.get(phaseRequestId(config.runId, 'enospc'), config.runId));
      check(previousFailure?.status === 'failed' && previousFailure.modelId === profile.modelId, 'PUBLIC_PHASE_REQUIRES_OWN_ENOSPC_RETRY');
      const beforeUnsupported = await readAcceptanceState(pool, store, profile, config.runId);
      const publicTreeBeforeUnsupported = await readdir(directories.publicDirectory);
      check(publicTreeBeforeUnsupported.length === 0, 'PUBLIC_CASE_EMPTY_BEFORE_UNSUPPORTED');
      const unsupportedFetches = { count: 0 };
      installer = createInstaller(store, profile, directories.publicDirectory, config.maxOperationMs, files, realPublicFetch);
      const catalog = createHuggingFaceCatalog({ profiles: [profile], fetchImpl: realPublicFetch, requestTimeoutMs: 10_000, maxQueryLength: 200, maxPageSize: 5 });
      const search = await catalog.search({ query: 'giga', page: { limit: 5 } });
      receipt.publicSearchResults = search.items.length;
      check(search.items.length > 0 && search.items.every(item => validateSchema('ModelRecord', item)), 'PUBLIC_SEARCH_SCHEMA_VALID');
      check(search.items.some(item => !item.supported && item.profileId === null), 'PUBLIC_SEARCH_HAS_UNSUPPORTED_RESULT');
      const remoteId = search.items.find(item => !item.supported && item.modelId.includes('/'))?.modelId;
      check(typeof remoteId === 'string', 'PUBLIC_SEARCH_REMOTE_ID_PRESENT');
      await installer.close();
      installer = createInstaller(store, profile, directories.publicDirectory, config.maxOperationMs, files, createPublicInstallFetch(unsupportedFetches).fetch);
      await expectInstallCode(installer, { ...profile, modelId: `unsupported-${config.runId.slice(0, 8)}` }, config.runId, 'unsupported-install', 'NOT_SUPPORTED');
      await expectInstallCode(installer, { ...profile, modelId: remoteId }, config.runId, 'slash-install', 'INVALID_ARGUMENT');
      await installer.close();
      installer = null;
      const afterUnsupported = await readAcceptanceState(pool, store, profile, config.runId);
      check(sameAcceptanceCounts(beforeUnsupported, afterUnsupported), 'UNSUPPORTED_REJECTIONS_NO_DB_CHANGE');
      check(unsupportedFetches.count === 0, 'UNSUPPORTED_REJECTIONS_NO_FETCH');
      check(isDeepStrictEqual(publicTreeBeforeUnsupported, await readdir(directories.publicDirectory)), 'UNSUPPORTED_REJECTIONS_NO_FILESYSTEM_CHANGE');
      receipt.unsupportedSelectorRejected = true;
      receipt.slashSelectorRejected = true;

      const request = installRequest(profile, config.runId, phaseRequestId(config.runId, 'public'), config.maxOperationMs);
      const downloads = { count: 0 };
      const barrier = createPublicInstallFetch(downloads, async () => {
        const rows = await pool.query("SELECT event_id FROM local_ai.outbox WHERE state='reserved' AND reservation_operation_id=$1::text", [request.requestId]);
        check(rows.rows.length === 1 && rows.rows[0].event_id !== request.requestId, 'PUBLIC_TERMINAL_RESERVATION_EXISTS');
        return rows.rows[0].event_id;
      });
      releaseFetchBarrier = barrier.release;
      installer = createInstaller(store, profile, directories.publicDirectory, config.maxOperationMs, files, barrier.fetch);
      const accepted = await installer.start(request);
      const repeatedWhileRunning = await installer.start(request);
      check(accepted.operationId === repeatedWhileRunning.operationId && repeatedWhileRunning.modelId === profile.modelId, 'RUNNING_REPEAT_IDEMPOTENT');
      const terminalEventId = await waitWithBound(barrier.entered, 15_000, 'PUBLIC_DOWNLOAD_BARRIER_TIMEOUT');
      const running = await installer.get(request.requestId, request.ownerId);
      check(['accepted', 'running'].includes(running.status), 'PUBLIC_OPERATION_NOT_READY_WHILE_BLOCKED');
      const readyBeforePublish = await store.transaction(tx => tx.installations.get(profile.modelId, profile.revision));
      check(readyBeforePublish === null, 'PUBLIC_NOT_READY_BEFORE_PUBLICATION');
      const finalDirectory = path.join(directories.publicDirectory, profile.modelId, profile.revision, profile.profileId);
      check(await pathExists(finalDirectory) === false, 'PUBLIC_FINAL_DIRECTORY_ABSENT_BEFORE_PUBLICATION');
      releaseFetchBarrier();
      releaseFetchBarrier = null;
      const progress = await waitForCompleted(installer, request, config.maxOperationMs);
      check(progress.terminal.status === 'completed' && progress.terminal.progressPercent === 100, 'PUBLIC_INSTALL_COMPLETED');
      check(progress.values.every((value, index) => index === 0 || value >= progress.values[index - 1]), 'PUBLIC_PROGRESS_MONOTONIC');
      check(progress.values.some(value => value > 0 && value < 100), 'PUBLIC_PROGRESS_INTERMEDIATE');
      receipt.progressMonotonic = progress.values.every((value, index) => index === 0 || value >= progress.values[index - 1]);
      receipt.progressIntermediate = progress.values.some(value => value > 0 && value < 100);
      check(downloads.count === files.length, 'PUBLIC_FETCH_ONCE_PER_PINNED_FILE');
      const installation = await store.transaction(tx => tx.installations.get(profile.modelId, profile.revision));
      check(installation?.directory === finalDirectory, 'PUBLIC_INSTALLATION_CANONICAL_DIRECTORY');
      await verifyPublishedTree(installation.directory, profile);
      const terminalRows = await pool.query("SELECT event_id,state,event FROM local_ai.outbox WHERE event_id=$1::uuid", [terminalEventId]);
      check(terminalRows.rows.length === 1 && terminalRows.rows[0].state === 'pending', 'PUBLIC_TERMINAL_EVENT_ID_STABLE');
      check(terminalRows.rows[0].event?.data?.outcome === 'succeeded' && terminalRows.rows[0].event?.data?.phase === 'publish', 'PUBLIC_TERMINAL_EVENT_SUCCEEDED');
      await installer.close();
      installer = createInstaller(store, profile, directories.publicDirectory, config.maxOperationMs, files, barrier.fetch);
      const repeatedAfterClose = await installer.start(request);
      check(repeatedAfterClose.operationId === progress.terminal.operationId && downloads.count === files.length, 'COMPLETED_REPEAT_NO_REFETCH');
      const afterRepeat = await readAcceptanceState(pool, store, profile, config.runId);
      check(afterRepeat.events.length === 5, 'COMPLETED_REPEAT_NO_NEW_EVENT');
      await installer.close();
      installer = null;
      const ownerProbe = createInstaller(store, profile, directories.publicDirectory, config.maxOperationMs, files, createPublicInstallFetch(downloads).fetch);
      const ownerOnly = await safeOutcome(() => ownerProbe.get(request.requestId, randomUUID()));
      await ownerProbe.close();
      check(ownerOnly === 'MODEL_NOT_FOUND', 'INSTALL_OPERATION_OWNER_SCOPE');
      const after = await readAcceptanceState(pool, store, profile, config.runId);
      check(after.installations.length === 1 && after.status.reserved === 0, 'PUBLIC_INSTALLATION_AND_TERMINAL_FACT');
      await assertMetadataOnly(after, profile, config.runId);
      receipt.installedFiles = files.length;
      receipt.verifiedBytes = totalBytes;
      receipt.progressSnapshots = progress.values.length;
      receipt.publicDownloads = downloads.count;
      receipt.terminalEventStable = true;
      receipt.metadataFacts = after.events.length;
      receipt.retryRequestId = phaseRequestId(config.runId, 'public');
    } else if (config.phase === 'inspect') {
      const state = await readAcceptanceState(pool, store, profile, config.runId);
      const failed = await store.transaction(tx => tx.installationOperations.get(phaseRequestId(config.runId, 'enospc'), config.runId));
      const completed = await store.transaction(tx => tx.installationOperations.get(phaseRequestId(config.runId, 'public'), config.runId));
      check(failed?.status === 'failed' && completed?.status === 'completed', 'INSPECT_OWN_OPERATION_HISTORY');
      check(state.installations.length === 1 && state.status.reserved === 0, 'INSPECT_OWN_FINAL_STATE');
      await assertMetadataOnly(state, profile, config.runId);
      const downloads = { count: 0 };
      installer = createInstaller(store, profile, directories.publicDirectory, config.maxOperationMs, files, createPublicInstallFetch(downloads).fetch);
      const repeated = await installer.start(installRequest(profile, config.runId, phaseRequestId(config.runId, 'public'), config.maxOperationMs));
      check(repeated.status === 'completed' && repeated.progressPercent === 100 && downloads.count === 0, 'NEW_PROCESS_REPEAT_READS_SAVED_OPERATION');
      const failedRepeat = await installer.start(installRequest(profile, config.runId, phaseRequestId(config.runId, 'enospc'), config.maxOperationMs));
      check(failedRepeat.status === 'failed' && failedRepeat.errorCode === 'INSTALLATION_FAILED' && downloads.count === 0, 'NEW_PROCESS_REPEAT_READS_FAILED_OPERATION');
      const afterRepeats = await readAcceptanceState(pool, store, profile, config.runId);
      check(sameAcceptanceCounts(state, afterRepeats), 'NEW_PROCESS_REPEATS_NO_DATABASE_CHANGE');
      receipt.savedOperationRead = true;
      receipt.failedOperationRead = true;
      receipt.metadataFacts = state.events.length;
    }
  } catch (error) {
    errorCode = safeCode(error);
  } finally {
    releaseFetchBarrier?.();
    if (installer) {
      try { await installer.close(); } catch { errorCode ??= 'INSTALLER_CLOSE_FAILED'; }
    }
    if (pool) {
      try { await pool.end(); } catch { errorCode ??= 'DATABASE_CLOSE_FAILED'; }
    }
  }
  receipt.passed = errorCode === null;
  receipt.elapsedMs = Date.now() - startedAt;
  receipt.watchdogMs = MAX_ATTEMPT_MS;
  if (errorCode !== null) receipt.errorCode = errorCode;
  t.diagnostic(`INSTALL_ACCEPTANCE_RECEIPT ${JSON.stringify(receipt)}`);
  if (errorCode !== null) throw new Error(`protected install acceptance failed (${errorCode})`);
});

function chooseAcceptedProfile() {
  const profiles = supportedProfiles({ runtime: { gigaam_pytorch: { longformMaximumSeconds: null } } });
  const profile = profiles.find(item => item.profileId === PROFILE_ID);
  check(Boolean(profile), 'ACCEPTED_PROFILE_PRESENT');
  check(profile.modelId === MODEL_ID && profile.repository === REPOSITORY && profile.revision === REVISION, 'ACCEPTED_PROFILE_PIN');
  check(profile.files.length === 4 && profile.record.limits.maxAudioSeconds === null, 'ACCEPTED_PROFILE_LIMITS');
  check(validateSchema('ModelRecord', profile.record), 'ACCEPTED_PROFILE_RECORD_SCHEMA');
  check(profile.record.files.length === profile.files.length && profile.files.every(file => profile.record.files.some(recordFile => recordFile.path === file.path
    && recordFile.sizeBytes === file.bytes && recordFile.sha256 === file.sha256)), 'ACCEPTED_PROFILE_RECORD_FILES');
  return profile;
}

function createInstaller(store, profile, rootDirectory, maxOperationMs, files, fetchImpl) {
  return createModelInstaller({
    store, profiles: [profile], rootDirectory, fetchImpl,
    limits: { maxDownloadBytes: files.reduce((total, file) => total + file.bytes, 0), maxFiles: 4, maxParallel: 1, maxOperationMs },
  });
}

function realPublicFetch(input, init = {}) {
  const url = new URL(input);
  check(url.origin === 'https://huggingface.co', 'PUBLIC_FETCH_FIXED_ORIGIN');
  check(init.headers?.authorization === undefined, 'PUBLIC_FETCH_HAS_NO_AUTHORIZATION');
  return fetch(input, init);
}

function createPublicInstallFetch(counter, onFirstFileRequest = null) {
  let resolveEntered;
  let release;
  let reservationId = null;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  let held = false;
  const fetchFn = async (input, init = {}) => {
    const url = new URL(input);
    check(url.origin === 'https://huggingface.co', 'PUBLIC_INSTALL_FIXED_ORIGIN');
    check(init.headers?.authorization === undefined, 'PUBLIC_INSTALL_HAS_NO_AUTHORIZATION');
    counter.count += 1;
    if (url.pathname.startsWith(`/${REPOSITORY}/resolve/${REVISION}/`)) {
      if (!held && onFirstFileRequest) {
        held = true;
        reservationId = await onFirstFileRequest();
        resolveEntered(reservationId);
        await gate;
      }
    }
    return globalThis.fetch(input, init);
  };
  return { fetch: fetchFn, entered, release: () => release(), get reservationId() { return reservationId; } };
}

function installRequest(profile, ownerId, requestId, maxOperationMs) {
  return {
    modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId,
    requestId, ownerId, deadlineAt: new Date(Date.now() + Math.min(maxOperationMs, MAX_ATTEMPT_MS)).toISOString(),
  };
}

async function waitForTerminal(installer, operationId, ownerId, boundMs) {
  const stopAt = Date.now() + boundMs;
  while (Date.now() < stopAt) {
    const operation = await installer.get(operationId, ownerId);
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(operation.status)) return operation;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  check(false, 'INSTALL_OPERATION_BOUNDED_TIMEOUT');
}

async function waitForCompleted(installer, request, boundMs) {
  const stopAt = Date.now() + boundMs;
  const values = [];
  while (Date.now() < stopAt) {
    const operation = await installer.get(request.requestId, request.ownerId);
    if (Number.isInteger(operation.progressPercent)) values.push(operation.progressPercent);
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(operation.status)) {
      check(operation.status === 'completed', 'PUBLIC_INSTALL_TERMINAL_SUCCESS');
      return { terminal: operation, values };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  check(false, 'PUBLIC_INSTALL_BOUNDED_TIMEOUT');
}

async function waitWithBound(promise, boundMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('acceptance bound elapsed'), { safeCode: code })), boundMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function pathExists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function expectInstallCode(installer, profile, ownerId, idSeed, expected) {
  const request = installRequest(profile, ownerId, phaseRequestId(ownerId, idSeed), 30_000);
  const outcome = await safeOutcome(() => installer.start(request));
  check(outcome === expected, `EXPECTED_${expected}`);
}

function phaseRequestId(runId, phase) {
  const hash = createHash('sha256').update(`brai-local-ai-install-acceptance:${runId}:${phase}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function safeOutcome(run) {
  try { await run(); return 'success'; }
  catch (error) { return typeof error?.code === 'string' ? error.code : 'UNEXPECTED'; }
}

async function assertPhaseDatabaseState(pool, store, profile, config) {
  const state = await readAcceptanceState(pool, store, profile, config.runId);
  if (config.phase === 'hash') {
    assertFreshInstallNamespace({
      models: state.models.length, installations: state.installations.length,
      operations: state.operations.length, settings: state.settings, outbox: state.events.length,
    });
    return;
  }
  check(state.models.length === 1 && isDeepStrictEqual(state.models[0], profile.record), 'OWN_PROFILE_REGISTERED');
  check(state.operations.every(row => row.owner_id === config.runId && row.model_id === profile.modelId), 'ONLY_OWN_INSTALL_OPERATIONS');
  check(state.events.every(row => row.event.actor_id === null || row.event.actor_id === config.runId), 'ONLY_OWN_METADATA_EVENTS');
  const failed = state.operations.find(row => row.operation_id === phaseRequestId(config.runId, 'enospc'));
  if (config.phase === 'enospc') {
    check(state.installations.length === 0, 'NO_EXISTING_INSTALLATION_BEFORE_RETRY');
    check(state.operations.length === 0, 'ENOSPC_PHASE_HAS_NO_PRIOR_OPERATION');
  } else if (config.phase === 'public') {
    check(state.installations.length === 0, 'NO_EXISTING_INSTALLATION_BEFORE_RETRY');
    check(failed?.record.status === 'failed', 'PUBLIC_RETRY_REQUIRES_PRIOR_ENOSPC_FAILURE');
  } else {
    check(state.installations.length === 1, 'INSPECT_OWN_FINAL_INSTALLATION');
    check(failed?.record.status === 'failed' && state.operations.some(row => row.operation_id === phaseRequestId(config.runId, 'public') && row.record.status === 'completed'), 'INSPECT_OWN_OPERATION_HISTORY');
  }
}

async function readAcceptanceState(pool, store, profile, ownerId) {
  const models = await store.transaction(tx => tx.models.list());
  const installations = await store.transaction(tx => tx.installations.list());
  const operationResult = await pool.query('SELECT operation_id,owner_id,model_id,record FROM local_ai.installation_operations ORDER BY operation_id');
  const settingsResult = await pool.query('SELECT count(*)::bigint AS count FROM local_ai.settings');
  const eventResult = await pool.query('SELECT event FROM local_ai.outbox ORDER BY event_id');
  const status = await store.status();
  check(Number(settingsResult.rows[0].count) === 0, 'NO_SETTINGS_ROWS');
  for (const row of operationResult.rows) check(validateSchema('InstallOperation', row.record), 'INSTALL_OPERATION_SCHEMA');
  for (const row of eventResult.rows) check(validateMetadataEvent(row.event), 'METADATA_EVENT_SCHEMA');
  check(models.length <= 1 && models.every(model => model.modelId === profile.modelId), 'ONLY_PINNED_MODEL_ROW');
  check(installations.length <= 1 && installations.every(item => item.modelId === profile.modelId && item.revision === profile.revision), 'ONLY_PINNED_INSTALLATION_ROW');
  check(operationResult.rows.every(row => row.owner_id === ownerId && row.model_id === profile.modelId), 'ONLY_RUN_OPERATION_ROWS');
  check(status.reserved <= 1 && status.sending === 0 && status.permanentlyFailed === 0, 'BOUNDED_UNDELIVERED_OUTBOX');
  return { models, installations, operations: operationResult.rows, settings: Number(settingsResult.rows[0].count), events: eventResult.rows, status };
}

function sameAcceptanceCounts(left, right) {
  return left.models.length === right.models.length
    && left.installations.length === right.installations.length
    && left.operations.length === right.operations.length
    && left.settings === right.settings
    && left.events.length === right.events.length
    && left.status.reserved === right.status.reserved
    && left.status.pending === right.status.pending;
}

async function assertHashCandidate(rootDirectory, profile) {
  const target = path.join(rootDirectory, profile.modelId, profile.revision, profile.profileId);
  await assertRunDirectory(target);
  const actualFiles = await listRegularFiles(target);
  check(actualFiles.length === profile.files.length, 'HASH_CANDIDATE_EXACT_FILE_COUNT');
  const mismatches = [];
  for (const file of profile.files) {
    const targetFile = path.join(target, file.path);
    const info = await lstat(targetFile);
    check(info.isFile() && !info.isSymbolicLink() && info.size === file.bytes, 'HASH_CANDIDATE_FILE_SHAPE');
    const digest = await hashFile(targetFile);
    if (digest !== file.sha256.toLowerCase()) mismatches.push(file.path);
  }
  check(mismatches.length === 1 && mismatches[0] === 'pytorch_model.bin', 'HASH_CANDIDATE_SINGLE_PINNED_FILE_MISMATCH');
}

async function assertEnospcMount(directory) {
  const info = await assertRunDirectory(directory);
  const filesystem = await statfs(directory);
  check(filesystem.type === TMPFS_MAGIC && Number(filesystem.blocks) * Number(filesystem.bsize) === 2 * 1024 * 1024, 'ENOSPC_TMPFS_SIZE');
  const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
  const entry = mountinfo.split('\n').map(line => line.split(' - ')).find(parts => parts.length === 2 && decodeMountPath(parts[0].split(' ')[4]) === directory);
  if (!entry) check(false, 'ENOSPC_MOUNT_TARGET');
  const mountOptions = entry[0].split(' ')[5].split(',');
  const details = entry[1].split(' ');
  const superOptions = details[2]?.split(',') ?? [];
  check(details[0] === 'tmpfs' && details[1] === 'tmpfs', 'ENOSPC_MOUNT_TYPE');
  check(['nosuid', 'nodev', 'noexec'].every(flag => mountOptions.includes(flag) || superOptions.includes(flag)), 'ENOSPC_MOUNT_FLAGS');
  check(info.uid === 1002 && info.gid === 1002, 'ENOSPC_MOUNT_OWNER');
}

async function assertPublicFilesystem(directory, requiredFreeBytes) {
  const info = await assertRunDirectory(directory);
  const filesystem = await statfs(directory);
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  check(filesystem.type !== TMPFS_MAGIC && freeBytes >= requiredFreeBytes, 'PUBLIC_FILESYSTEM_CAPACITY');
  check(info.uid === 1002 && info.gid === 1002, 'PUBLIC_FILESYSTEM_OWNER');
}

async function assertRunDirectory(directory) {
  const info = await lstat(directory);
  check(info.isDirectory() && !info.isSymbolicLink(), 'CASE_DIRECTORY_NOT_LINK');
  check(await realpath(directory) === directory, 'CASE_DIRECTORY_REALPATH');
  check(info.uid === 1002 && info.gid === 1002 && (info.mode & 0o022) === 0, 'CASE_DIRECTORY_OWNER_MODE');
  return info;
}

async function listRegularFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    check(!entry.isSymbolicLink(), 'CASE_TREE_HAS_NO_LINKS');
    if (entry.isDirectory()) result.push(...await listRegularFiles(full, relative));
    else if (entry.isFile()) result.push(relative);
    else check(false, 'CASE_TREE_HAS_ONLY_FILES');
  }
  return result.sort();
}

async function verifyPublishedTree(directory, profile) {
  await assertRunDirectory(directory);
  const actual = await listRegularFiles(directory);
  const expected = profile.files.map(file => file.path).sort();
  check(JSON.stringify(actual) === JSON.stringify(expected), 'PUBLISHED_TREE_EXACT');
  for (const file of profile.files) {
    const info = await lstat(path.join(directory, file.path));
    check(info.size === file.bytes && await hashFile(path.join(directory, file.path)) === file.sha256.toLowerCase(), 'PUBLISHED_FILE_HASH');
  }
}

async function assertNoFinalOrStagingDirectory(rootDirectory, profile, operationId) {
  const parent = path.join(rootDirectory, profile.modelId, profile.revision);
  const names = await readdir(parent);
  check(!names.includes(profile.profileId) && !names.includes(`.staging-${operationId}`), 'ENOSPC_NO_FINAL_OR_STAGING');
}

async function assertMetadataOnly(state, profile, ownerId) {
  check(state.events.length === 5 && state.status.pending === 5 && state.status.reserved === 0, 'OWN_OUTBOX_FACT_COUNT');
  check(state.events.every(row => validateMetadataEvent(row.event)), 'OUTBOX_METADATA_SCHEMA_ONLY');
  check(state.events.every(row => row.event.data.modelId === profile.modelId), 'OUTBOX_ONLY_PINNED_MODEL');
  check(state.operations.every(row => row.owner_id === ownerId), 'OUTBOX_OWNER_SCOPE');
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 8)));
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function check(condition, code) {
  if (!condition) throw Object.assign(new Error('protected install acceptance assertion failed'), { safeCode: code });
}

function safeCode(error) {
  const allowed = new Set([
    'PINNED_MANIFEST', 'ACCEPTED_PROFILE_PRESENT', 'ACCEPTED_PROFILE_PIN', 'ACCEPTED_PROFILE_LIMITS',
    'ACCEPTED_PROFILE_RECORD_SCHEMA', 'ACCEPTED_PROFILE_RECORD_FILES', 'PUBLIC_FETCH_FIXED_ORIGIN',
    'PUBLIC_FETCH_HAS_NO_AUTHORIZATION', 'PUBLIC_INSTALL_FIXED_ORIGIN', 'PUBLIC_INSTALL_HAS_NO_AUTHORIZATION',
    'HASH_MISMATCH_REJECTED', 'HASH_REJECTION_NO_DB_CHANGE', 'HASH_REJECTION_NOT_READY',
    'ENOSPC_TMPFS_SIZE', 'ENOSPC_MOUNT_TARGET', 'ENOSPC_MOUNT_TYPE', 'ENOSPC_MOUNT_FLAGS', 'ENOSPC_MOUNT_OWNER',
    'ENOSPC_PHASE_BASELINE', 'NATIVE_ENOSPC_WRITE_OBSERVED', 'INSTALLER_TERMINATED_WITH_SAFE_STATUS',
    'ENOSPC_TERMINAL_FAILED', 'ENOSPC_NO_INSTALLATION', 'ENOSPC_TERMINAL_RESERVATION_CLOSED',
    'ENOSPC_NO_FINAL_OR_STAGING', 'PUBLIC_FILESYSTEM_CAPACITY', 'PUBLIC_FILESYSTEM_OWNER',
    'PUBLIC_PHASE_REQUIRES_OWN_ENOSPC_RETRY', 'PUBLIC_SEARCH_SCHEMA_VALID', 'PUBLIC_SEARCH_HAS_UNSUPPORTED_RESULT',
    'PUBLIC_SEARCH_REMOTE_ID_PRESENT', 'UNSUPPORTED_REJECTIONS_NO_DB_CHANGE', 'RUNNING_REPEAT_IDEMPOTENT',
    'PUBLIC_INSTALL_TERMINAL_SUCCESS', 'PUBLIC_PROGRESS_MONOTONIC', 'PUBLIC_PROGRESS_INTERMEDIATE',
    'PUBLIC_INSTALL_COMPLETED', 'PUBLIC_FETCH_ONCE_PER_PINNED_FILE', 'PUBLISHED_TREE_EXACT', 'PUBLISHED_FILE_HASH',
    'COMPLETED_REPEAT_NO_REFETCH', 'INSTALL_OPERATION_OWNER_SCOPE', 'PUBLIC_INSTALLATION_AND_TERMINAL_FACT',
    'OWN_OUTBOX_FACT_COUNT', 'OUTBOX_METADATA_SCHEMA_ONLY', 'OUTBOX_ONLY_PINNED_MODEL', 'OUTBOX_OWNER_SCOPE',
    'INSTALL_OPERATION_BOUNDED_TIMEOUT', 'PUBLIC_INSTALL_BOUNDED_TIMEOUT', 'EXPECTED_NOT_SUPPORTED',
    'EXPECTED_INVALID_ARGUMENT', 'OWN_PROFILE_REGISTERED', 'NO_EXISTING_INSTALLATION_BEFORE_RETRY',
    'ONLY_OWN_INSTALL_OPERATIONS', 'ONLY_OWN_METADATA_EVENTS', 'ENOSPC_PHASE_HAS_NO_PRIOR_OPERATION',
    'TEST_TIMEOUT_MATCHES_WATCHDOG', 'COMPLETED_REPEAT_NO_NEW_EVENT', 'INSPECT_OWN_FINAL_INSTALLATION',
    'NEW_PROCESS_REPEAT_READS_SAVED_OPERATION', 'PUBLIC_FINAL_DIRECTORY_ABSENT_BEFORE_PUBLICATION',
    'PUBLIC_INSTALLATION_CANONICAL_DIRECTORY', 'PUBLIC_NOT_READY_BEFORE_PUBLICATION',
    'PUBLIC_OPERATION_NOT_READY_WHILE_BLOCKED', 'PUBLIC_TERMINAL_EVENT_ID_STABLE',
    'PUBLIC_TERMINAL_EVENT_SUCCEEDED', 'PUBLIC_TERMINAL_RESERVATION_EXISTS', 'NO_SETTINGS_ROWS',
    'PUBLIC_CASE_EMPTY_BEFORE_UNSUPPORTED', 'UNSUPPORTED_REJECTIONS_NO_FETCH',
    'UNSUPPORTED_REJECTIONS_NO_FILESYSTEM_CHANGE', 'NEW_PROCESS_REPEAT_READS_FAILED_OPERATION',
    'NEW_PROCESS_REPEATS_NO_DATABASE_CHANGE',
    'PUBLIC_RETRY_REQUIRES_PRIOR_ENOSPC_FAILURE', 'INSTALL_OPERATION_SCHEMA', 'METADATA_EVENT_SCHEMA',
    'ONLY_PINNED_MODEL_ROW', 'ONLY_PINNED_INSTALLATION_ROW', 'ONLY_RUN_OPERATION_ROWS', 'BOUNDED_UNDELIVERED_OUTBOX',
    'INSPECT_OWN_OPERATION_HISTORY', 'INSPECT_OWN_FINAL_STATE', 'CASE_DIRECTORY_NOT_LINK', 'CASE_DIRECTORY_REALPATH',
    'CASE_DIRECTORY_OWNER_MODE', 'CASE_TREE_HAS_NO_LINKS', 'CASE_TREE_HAS_ONLY_FILES', 'HASH_CANDIDATE_EXACT_FILE_COUNT',
    'HASH_CANDIDATE_FILE_SHAPE', 'HASH_CANDIDATE_SINGLE_PINNED_FILE_MISMATCH', 'ACCEPTED_PROFILE_FILE_MANIFEST',
  ]);
  return allowed.has(error?.safeCode) ? error.safeCode : 'UNEXPECTED';
}
