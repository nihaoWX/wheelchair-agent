# HARNESS
## Concepts
- HARNESS: The `*.md` files, `docs/`, and `steps/` mentioned in the "## Implementation" are called HARNESS.
- Role of HARNESS: Ensure the continuity and stability of agent operations using a set of standardized work procedures.
- How to create HARNESS: When a complex task requires one and the directory has none, create HARNESS there: minimum `ARCHITECTURE.md` + `PROGRESS.md`, plus `ARCHITECTURE/*.md`/`docs/`/`steps/` as needed.

## Implementation
- `PROGRESS.md`: Records the current work progress, what has been completed, what is in progress, current issues, and what to do next.
  1. Overwrite updates: Record only the current state, not history; consult git if historical information is needed.
  2. Format: "# Current State", "# Completed", "# In Progress", "# Known Issues", "# Next Steps".
- `ARCHITECTURE.md`: Records the definition of this task (types: project-development / research), its overall architecture, and an index of reference materials; it does not record specific implementation details or the development process.
  1. Progressively updated and refined as the task develops.
  2. Must stay concise, below 20kb. `# Definition` and `# Structure` are overview and index — not a dump. When design detail grows, distribute by function/part/logic/sequence to `ARCHITECTURE/*.md` or `ARCHITECTURE/<domain>/*.md` and link from `ARCHITECTURE.md`.
  3. Project-development task: format is `# Definition` + `# Structure`. `# Definition` — the project definition and user expectations. `# Structure` — the file layout of the whole project, the purpose of each part, and an index of reference materials for dependencies (tutorials/API documentation, indexed in `docs/`).
  4. Research task: format is `# Definition` + `# Chain`. `# Definition` — the research topic and user expectations. `# Chain` — the full-course record of the research task from its start, in logical/chronological order: each step's topic, result, and the path to detailed results (indexed in `steps/`; steps moved to `steps/TRASH/` are excluded). Unlike the state-snapshot `PROGRESS.md`, it preserves the whole history.
- `docs/`: Knowledge base — e.g. repositories, literature, and materials organized by the user or agents.
  1. `docs/` organized by knowledge category: `docs/<domain>/`, `docs/<domain>/<subdomain>/`
  2. `docs/PITFALLS/`: Similar to GitHub issues, managed by skill `pitfalls-manager`, it tracks changes and the reasons for the projects. It’s important for project development—just use it.
  3. Contents depend on task type: a project-development task stores API docs, official tutorials, etc. for its dependencies; a research task stores literature and similar materials.
- `steps/`: Research-task-specific; recommended when conducting a research task (DO NOT create it in projects-development task). Stores each step's data, scripts, reports, etc.
  1. `steps/<step>/`: one step per directory, named with an ordered prefix (`01_<topic>/`, `01a_<topic>/`, ...) matching the order of `# Chain`.
  2. `steps/<step>/*_report.md`: every step must contain a report; reference materials are indexed in `docs/`.
  3. `steps/TRASH/<step>/`: deprecated steps; move them here instead of deleting.

# AGENT ROLE
Roles are contextual: whoever delegates work to sub-agents acts as the Orchestrator for that delegation — usually the user-facing agent; an Executor that spawns sub-agents also acts as Orchestrator for its own subtree.
- Orchestrator:
  1. AVOID performing tasks yourself, such as modifying code or consulting documentation; you may edit only HARNESS files and execute small/single-step tasks directly.
  2. Is the primary maintainer of all HARNESS files, each updated at the right time: `PROGRESS.md` whenever the work state changes (must reflect the current state at the end of a session), `ARCHITECTURE.md` as the task develops (keep `# Chain` or `# Structure` current), `docs/PITFALLS/` as soon as a pitfall is encountered.
  3. When a task may require a large amount of context, actively break down the task and invoke sub-agents. The git environment must be clean before delegating tasks.
  4. Complex tasks (multi-step or context-heavy) must first delegate to two Executors in sequence: a Generator and an Evaluator. The Generator produces the work first; the Evaluator then reviews it adversarially (correctness, completeness, risks). Issues found MUST be fixed by the Generator; the cycle repeats until the Evaluator passes. If the Generator fails 3 consecutive rounds, the Orchestrator takes over: dispatch a new Executor or change strategy.
  5. Task planning MUST be grounded in authoritative sources, e.g. dependency API docs, GitHub repositories, official tutorials, and literature.
- Executor:
  1. Executor is usually a sub-agent, responsible for actually carrying out the task.
  2. When a task/sub-task may require a large amount of context, actively break down the task/sub-task and invoke sub-agents.
  3. Must not modify `PROGRESS.md` and `ARCHITECTURE.md`; within HARNESS may write only to `docs/` and `steps/`.
  4. After being delegated a task by the Orchestrator, must first inspect `ARCHITECTURE.md` and `PROGRESS.md`; consult other information only if information is still missing after reading them.
  5. Must keep the git environment clean both before and after completing the task.
  6. Before executing, review the necessary authoritative sources to constrain the scope of the TODO list.

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
