# Evaluation runbook

These fixtures exercise the [baseline](evaluation-baseline-v1.md). Read the
[results and coverage ledger](evaluation-results-v1.md) before interpreting them.

## Environment

Run from the repository root. Requires Docker and Node on the host. The containers
receive only the read-only evaluation scripts. No ports are published.

```bash
docker build -t retinue-evaluation:2026-10-03 -f evaluation/Dockerfile evaluation
docker run -d --name retinue-eval-paperclip \
  -v "$PWD/evaluation:/evaluation:ro" retinue-evaluation:2026-10-03
docker run -d --name retinue-eval-openrig \
  -v "$PWD/evaluation:/evaluation:ro" retinue-evaluation:2026-10-03

docker exec -d -e PAPERCLIP_RUNNER_ENABLED=false retinue-eval-paperclip \
  paperclipai onboard --yes --no-install-service --data-dir /home/node/evaluation-state
docker exec retinue-eval-openrig \
  rig daemon start --no-kernel --host 127.0.0.1 --port 17300
```

Wait for Paperclip `/api/health` to return 200 before creating records:

```bash
docker exec retinue-eval-paperclip node /evaluation/api.mjs \
  http://127.0.0.1:3100 GET /api/health
docker exec retinue-eval-paperclip node /evaluation/api.mjs \
  http://127.0.0.1:3100 POST /api/companies '{"name":"Retinue evaluation"}'

docker exec retinue-eval-openrig rig create daily --runtime stub --json
docker exec retinue-eval-openrig rig create project --runtime stub --json
docker exec retinue-eval-openrig rig create landing --runtime stub --json
docker exec retinue-eval-openrig rig create monitor --runtime stub --json
docker exec retinue-eval-openrig rig create graph --runtime stub --json
```

Container names prevent accidental duplicate setup. Use fresh isolated containers
for a new evaluation. The initial probe refuses to rerun after its completion
marker. Discovery/setup probes performed before the scripted pass produced one
extra Paperclip Daily agent in the recorded evidence. It is not required.

## Tests

```bash
docker exec retinue-eval-paperclip node /evaluation/probe.mjs paperclip
docker exec retinue-eval-openrig node /evaluation/probe.mjs openrig
docker exec retinue-eval-paperclip node /evaluation/paperclip-runs.mjs
docker exec retinue-eval-paperclip node /evaluation/paperclip-extra.mjs
docker exec retinue-eval-paperclip node /evaluation/paperclip-staleness.mjs
docker exec retinue-eval-openrig node /evaluation/openrig-deep.mjs
docker exec retinue-eval-openrig node /evaluation/openrig-followup.mjs
docker exec retinue-eval-paperclip node /evaluation/worktree.mjs
docker exec retinue-eval-openrig node /evaluation/worktree.mjs
```

Some scripts deliberately try invalid requests before using the correct public
shape. See the report's error section. They are investigative probes, not an
upstream conformance suite. Run-scoped fixtures generate fresh task identities
for each complete rerun. API secrets stay inside the Paperclip container in a
mode-0600 state file and are excluded from collected evidence.

`worktree.mjs` is an independent coordinator/Git fixture, not either product's
worktree implementation. It recognises its completed result on repeat invocation.

## Restart and explicit retirement

```bash
docker exec retinue-eval-openrig rig daemon stop
docker exec retinue-eval-openrig \
  rig daemon start --no-kernel --host 127.0.0.1 --port 17300
docker exec retinue-eval-openrig node /evaluation/probe.mjs openrig recovery
docker exec retinue-eval-openrig node /evaluation/openrig-retire.mjs

docker restart retinue-eval-paperclip
docker exec -d -e PAPERCLIP_RUNNER_ENABLED=false retinue-eval-paperclip \
  paperclipai run --data-dir /home/node/evaluation-state
# Wait for /api/health again.
docker exec retinue-eval-paperclip node /evaluation/probe.mjs paperclip recovery

node evaluation/collect.mjs
```

The collector saves sanitised response evidence and asserts the reported key
outcomes. Full instance data is retained inside the containers for investigation.

## Stop the evaluation

```bash
docker stop retinue-eval-paperclip retinue-eval-openrig
```

Both evaluation containers were stopped after the recorded run. Their filesystems
and the build image remain available. Starting containers alone does not restart
the services because their main command is `sleep infinity`.

For a later clean run, remove these specifically named evaluation containers after
preserving any desired evidence, then repeat setup. Do not reuse a populated
instance as though it were an empty baseline.
