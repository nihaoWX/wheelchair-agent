# HARNESS
## Concepts
- HARNESS: The `*.md` files and `docs/` mentioned in the "## Implementation" are called HARNESS.
- Role of HARNESS: Ensure the continuity and stability of agent operations using a set of standardized work procedures.
- How to create HARNESS: When a complex task requires one and the directory has none, create HARNESS there: minimum `ARCHITECTURE.md` + `PROGRESS.md`, plus `ARCHITECTURE/*.md`/`docs/` as needed.

## Implementation
### `PROGRESS.md` 
Records the current work progress, what has been completed, what is in progress, current issues, and what to do next.

- Overwrite updates: Record only the current state, not history; consult git if historical information is needed.
- Format: "# Current State", "# Completed", "# In Progress", "# Known Issues", "# Next Steps".

### `ARCHITECTURE.md` and `ARCHITECTURE/`
Records the definition of project-development task, its overall architecture, and an index of reference materials; it does not record specific implementation details or the development process.

- Progressively updated and refined as the task develops.
- Must stay concise, below 20kb. `# Definition` and `# Structure` are overview and index — not a dump. When design detail grows, distribute by function/part/logic/sequence to `ARCHITECTURE/*.md` or `ARCHITECTURE/<domain>/*.md` and link from `ARCHITECTURE.md`.
- Project-development task: format is `# Definition` + `# Structure`. `# Definition` — the project definition and user expectations. `# Structure` — the file layout of the whole project, the purpose of each part, and an index of reference materials for dependencies (tutorials/API documentation, indexed in `docs/`).

### `docs/`
Knowledge base — stores API docs, official tutorials, literature, etc. for its dependencies.

- `docs/` organized by knowledge category: `docs/<domain>/`, `docs/<domain>/<subdomain>/`
- `docs/PITFALLS/`: Similar to GitHub issues, managed by skill `pitfalls-manager`, it tracks changes and the reasons for the projects. It’s important for project development—just use it.

# AGENT ROLE

WHEN AGENT READ THIS, YOU ARE WORKER.

## spv and worker
- A supervisor(spv) oversees long-term, multi-project, high-level objectives.
- A Worker focuses on a single project. In practice, a worker acts as an Arranger, delegating tasks to sub-agents (Executors) to break down complex assignments.
- Different cwd: spv `bioagentforge/`, worker `research/<a task>` or `tools/<a tool>`.
- Different `.git`: spv manage `bioagentforge/.git`, worker manage `tools/<a tool>/.git`. Spv is free to use the `tools/<a tool>/.git` of a worker, but worker cannot use the `bioagentforge/.git` of spv.
- Different `AGENTS.md`: spv `bioagentforge/AGENTS.md`, worker `tools/<a tool>/AGENTS.md`. This strategy allows an agent to clearly understand its own identity, as the user specifies the agent's role within the "AGENT ROLE" section of the corresponding `AGENTS.md` file.

## worker acts as Arranger:
- AVOID performing tasks yourself, such as modifying code or consulting documentation; you may edit only HARNESS files and execute small/single-step tasks directly.
- Is the primary maintainer of all HARNESS files, each updated at the right time: `PROGRESS.md` whenever the work state changes (must reflect the current state at the end of a session), `ARCHITECTURE.md` as the task develops (keep `# Structure` current), `docs/PITFALLS/` as soon as a pitfall is encountered.
- When a task may require a large amount of context, actively break down the task and invoke sub-agents. The git environment must be clean before delegating tasks.
- Complex tasks (multi-step or context-heavy) must first delegate to two Executors in sequence: a Generator and an Evaluator. The Generator produces the work first; the Evaluator then reviews it adversarially (correctness, completeness, risks). Issues found MUST be fixed by the Generator; the cycle repeats until the Evaluator passes. If the Generator fails 3 consecutive rounds, the Arranger takes over: dispatch a new Executor or change strategy.
- Task planning MUST be grounded in authoritative sources, e.g. dependency API docs, GitHub repositories, official tutorials, and literature.

## worker's subagent acts as Executor:
- Executor is usually a sub-agent, responsible for actually carrying out the task.
- When a task/sub-task may require a large amount of context, actively break down the task/sub-task and invoke sub-agents.
- Must not modify `PROGRESS.md` and `ARCHITECTURE.md`; within HARNESS may write only to `docs/`.
- After being delegated a task by the Arranger, must first inspect `ARCHITECTURE.md` and `PROGRESS.md`; consult other information only if information is still missing after reading them.
- Must keep the git environment clean both before and after completing the task.
- Before executing, review the necessary authoritative sources to constrain the scope of the TODO list.

# worker workflow
- 1. Load skill: `pitfalls-manager`
- 2. Worker acts as Arranger, break down complex task and delegated Executor.
- 3. Use `pitfalls-manager` to complete the task. If worker encounter any bugs or identify areas for optimization, submit an issue at `nihaoWX/pitfalls-manager`.

# Environment
## python
- Small scripts and non-bioinformatics tasks: `~/.venv/`.
- Bioinformatics tasks: micromamba/docker.
  1. Do not install third-party packages into the system Python.
  2. `python-bio` is the general-purpose Python bioinformatics micromamba environment.
  3. When a bioinformatics project requires additional dependencies or specific versions, prefer creating a separate micromamba/docker environment(recommended docker, espectially complex environments) for that project rather than polluting the shared environment.
## R
- Use micromamba `r453` to manage R environment.
## Docker
- Recommendations for Complex Environments, like CUDA. 
