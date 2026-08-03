# OpenCode MCP Memory

A production-ready MCP (Model Context Protocol) memory server for OpenCode with semantic search, project conventions learning, and comprehensive memory management.

## Features

- **Semantic memory search** via sentence-transformers with automatic text search fallback
- **Multiple memory types**: Working, semantic, episodic, procedural, plus domain-specific types
- **Project convention learning**: Auto-detect project type, tools, commands, dependencies
- **Knowledge graph**: Automatic relationship detection between related memories
- **Duplicate detection**: MD5-based content hashing to prevent redundant storage
- **Configurable embeddings**: Support for different sentence-transformers models
- **Full-text search**: SQLite FTS5 with fallback LIKE queries
- **Comprehensive metrics**: Track operation performance and success rates
- **Input validation & security**: Prevent path traversal and malicious inputs

## Quick Start

The launcher automatically creates a `.venv` and installs dependencies on first run:

```bash
python mcp_memory/launcher.py
```

Or use the console entry point (after installation):
```bash
mcp-memory
```

## Installation

### From PyPI (recommended)

```bash
pip install opencode-mcp-memory
```

Then run directly:
```bash
mcp-memory
```

Or use with `uvx`:
```bash
uvx opencode-mcp-memory
```

### From Source (development)

```bash
# Clone and install in editable mode
git clone https://github.com/opencode/mcp-memory.git
cd mcp-memory
pip install -e .

# Run the server
mcp-memory
```

### For OpenCode Integration

Use `uvx` in your MCP configuration:

```json
{
  "mcpServers": {
    "opencode-memory": {
      "command": "uvx",
      "args": ["opencode-mcp-memory"],
      "env": {}
    }
  }
}
```

## Architecture

- `server.py` - FastMCP server with 22 tools
- `launcher.py` - Venv-aware launcher (creates `.venv` on first run)
- `memory.py` - Memory classification & semantic search with lazy loading
- `database.py` - SQLite3 backend with FTS5, transactions, and migrations
- `conventions.py` - Project type detection & command learning
- `classification_config.py` - Configurable keywords for memory classification
- `metrics.py` - Operation metrics and health monitoring
- `validation.py` - Input validation and security utilities
- `exceptions.py` - Custom exception types
- `types.py` - Response type models

## Memory Types & Best Practices

### Working Memory
Short-term focus and task state. Good for:
- Current task context
- Active feature being implemented
- Debugging session state

Example:
```python
memory_manager.add_working_memory(
    slot="current_feature",
    value="Implementing user authentication with OAuth2"
)
```

### Semantic Memory
Durable factual knowledge. Good for:
- Programming language features
- Framework best practices
- Architecture decisions
- Code patterns

Example:
```python
memory_manager.add_semantic_memory(
    content="Python's GIL prevents true parallelism in threads but asyncio enables concurrent I/O",
    importance=0.9
)
```

### Episodic Memory
Events that occurred. Good for:
- Bugs encountered and fixed
- Deployment events
- Meetings and decisions made
- Refactoring activities

Example:
```python
memory_manager.add_episodic_memory(
    content="Fixed critical memory leak in WebSocket handler by adding proper cleanup"
)
```

### Procedural Memory
How to do something. Good for:
- Build and test commands
- Deployment procedures
- Development workflows
- Debugging techniques

Example:
```python
memory_manager.add_procedural_memory(
    content="To run tests: pytest --cov=src tests/; generates coverage report in htmlcov/",
    importance=0.8
)
```

### Domain-Specific Types

**error**: Bug reports, exceptions, failures
**code**: Code snippets, algorithms, implementations
**decision**: Architectural choices, approach selections
**pattern**: Design patterns, code templates, conventions
**environment**: OS and runtime configuration
**commands**: Build, test, deploy scripts
**tools**: Development tools and configurations
**deployment**: Deployment procedures and platforms
**testing**: Test frameworks and test procedures

## Common Workflows

### Initialize Project Memory

```python
from mcp_memory.database import DatabaseManager
from mcp_memory.memory import MemoryManager
from mcp_memory.conventions import ProjectConventionLearner

db = DatabaseManager("project.db")
mem = MemoryManager(db)
conv = ProjectConventionLearner(mem, db)

# Start session for current project
mem.start_session(".")

# Learn all conventions
conventions = conv.auto_learn_project_conventions(".")

# Query context
context = mem.get_memory_context("authentication")
```

### Search Memories

```python
# Semantic search (with fallback to text)
results = mem.search_memories_semantic("How to handle errors", min_similarity=0.5)

# Text search
results = db.search_memories("error handling", project_id=mem.current_project_id, limit=10)

# Get memories by type
error_logs = db.get_memories(project_id=mem.current_project_id, memory_type="error", limit=20)
```

### Store and Retrieve Context

```python
# Add different memory types
mem.add_working_memory("current_task", "Optimize database queries")
mem.add_semantic_memory("SQL indexes improve query performance on large tables")
mem.add_episodic_memory("Performance improved 5x after adding composite index")
mem.add_procedural_memory("Run: ANALYZE queries.log to find slow queries")

# Get formatted context for AI
context = mem.get_memory_context(query="database optimization")
print(context)
```

## Tools

### Health & Monitoring (3 tools)
- `health_check()` - Server status, database, embeddings, metrics
- `get_database_stats()` - Database statistics and sizes
- `get_metrics()` - Operation metrics and performance data

### Memory Operations (5 tools)
- `add_memory()` - Generic memory with type/importance
- `search_memories()` - Full-text search
- `search_semantic_memories()` - Semantic search with fallback
- `get_memory_context()` - Context for AI (includes conventions)
- `get_project_summary()` - Project statistics

### Memory Helpers (4 tools)
- `add_working_memory()` - Add working memory
- `add_semantic_memory()` - Add factual knowledge
- `add_episodic_memory()` - Add event record
- `add_procedural_memory()` - Add how-to knowledge

### Conventions (3 tools)
- `auto_learn_project_conventions()` - Scan project and learn conventions
- `get_project_conventions()` - Get cached conventions for context
- `suggest_correct_command()` - Suggest project-specific commands

### Maintenance (4 tools)
- `cleanup_old_data()` - Remove old low-importance memories
- `optimize_memories()` - Merge duplicates, clean relationships
- `remember_project_pattern()` - Store a reusable pattern
- (2 more specialized tools)

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `~/mcp-memory` | Data and log directory |
| `LOG_LEVEL` | `INFO` | Logging level (DEBUG, INFO, WARNING, ERROR) |
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Sentence-transformers model name |
| `HF_TOKEN` | (none) | HuggingFace token for faster model downloads |

### Embedding Models

The `EMBEDDING_MODEL` environment variable controls which sentence-transformers model to use:

```bash
# Smaller, faster (384-dim)
export EMBEDDING_MODEL=all-MiniLM-L6-v2

# Larger, more accurate (384-dim)
export EMBEDDING_MODEL=all-mpnet-base-v2

# Multilingual (384-dim)
export EMBEDDING_MODEL=sentence-transformers/multilingual-MiniLM-L6-v2

# Disable embeddings (text search only)
export EMBEDDING_MODEL=disabled
```

### Classification Configuration

Customize memory classification in `classification_config.py`:

```python
MEMORY_TYPE_KEYWORDS = {
    'error': {
        'keywords': ('error', 'exception', 'bug', ...),
        'base_importance': 0.8,
        'description': 'Error or issue'
    },
    # ... more types
}

IMPORTANCE_MODIFIERS = {
    'critical': 0.3,
    'security': 0.25,
    # ... more modifiers
}
```

## OpenCode Integration

Add to your `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "mcp-memory": {
      "type": "local",
      "command": ["py", "mcp_memory/launcher.py"],
      "cwd": "C:/Users/cbunt/.config/opencode/plugins/plugin-mcp-memory",
      "enabled": true
    }
  }
}
```

## Data Storage

- **Database**: `~/mcp-memory/data/mcp_memory.db` (SQLite3)
- **Logs**: `~/mcp-memory/logs/mcp_memory_YYYYMMDD.log`
- **Virtual Env**: `.venv/` in project directory

## Performance Considerations

- **Semantic search lazy loads** embedding model on first use (improves startup)
- **Automatic relationship detection** uses similarity threshold (default 0.7, configurable)
- **Full-text search fallback** ensures results even if embeddings unavailable
- **Duplicate detection** prevents redundant storage and search clutter
- **Context windows** limit memory loaded per session (default: 50 memories)

## Security

- **Input validation**: Prevents path traversal and injection attacks
- **Content sanitization**: Dangerous characters removed from inputs
- **Transaction support**: Ensures database consistency
- **Error handling**: Sensitive details not exposed in error messages

## Development

### Running Tests

```bash
pytest tests/ -v
```

### Building & Installing

```bash
pip install -e .
mcp-memory  # Run the server
```

### Debugging

Set log level:
```bash
export LOG_LEVEL=DEBUG
python mcp_memory/launcher.py
```

Check metrics:
```python
from mcp_memory.metrics import get_metrics_collector
collector = get_metrics_collector()
print(collector.get_summary())
```
