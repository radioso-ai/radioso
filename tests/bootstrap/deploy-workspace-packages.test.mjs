import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

const readRepoFile = (filePath) => readFile(path.join(repoRoot, filePath), "utf8");

test("production Dockerfiles include compiled routine workspace packages", async () => {
  const [backendDockerfile, frontendDockerfile] = await Promise.all([
    readRepoFile("infra/backend.Dockerfile"),
    readRepoFile("infra/frontend.Dockerfile"),
  ]);

  // The backend compiles routine definitions; only the dashboard renders the routine
  // document, so the projection package ships in the frontend image alone.
  for (const packageName of ["routine-definition"]) {
    assert.match(
      backendDockerfile,
      new RegExp(`COPY packages/${packageName}/package\\.json ./packages/${packageName}/package\\.json`),
    );
    assert.match(
      backendDockerfile,
      new RegExp(`COPY packages/${packageName} ./packages/${packageName}`),
    );
    assert.match(
      backendDockerfile,
      new RegExp(`COPY --chown=node:node --from=build /app/packages/${packageName}/dist ./packages/${packageName}/dist`),
    );
  }

  assert.doesNotMatch(backendDockerfile, /packages\/routine-document/);

  for (const packageName of ["routine-definition", "routine-document"]) {
    assert.match(
      frontendDockerfile,
      new RegExp(`COPY packages/${packageName}/package\\.json ./packages/${packageName}/package\\.json`),
    );
    assert.match(
      frontendDockerfile,
      new RegExp(`COPY packages/${packageName} ./packages/${packageName}`),
    );
    assert.match(
      frontendDockerfile,
      new RegExp(`COPY --chown=node:node --from=builder /app/packages/${packageName} ./packages/${packageName}`),
    );
  }
});

test("staging deploy runs when routine workspace packages change", async () => {
  const deployStaging = await readRepoFile(".github/workflows/deploy-staging.yml");

  assert.match(deployStaging, /packages\/routine-definition\/\*\*/);
  assert.match(deployStaging, /packages\/routine-document\/\*\*/);
});
