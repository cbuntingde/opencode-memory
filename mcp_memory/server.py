"""
MCP Memory Server
Clean memory server using FastMCP and SQLite.
"""

import os
import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastmcp import FastMCP

from .database import DatabaseManager
from .memory import MemoryManager
from .conventions import ProjectConventionLearner
from .metrics import get_metrics_collector, OperationTimer
from .api_response import success_response, error_response, paginated_response, search_response, health_response

# Configure logging
base_dir = Path(os.path.abspath(os.getenv('DATA_DIR', os.path.join(os.path.expanduser('~'), 'mcp-memory'))))
try:
    base_dir.mkdir(parents=True, exist_ok=True)
except PermissionError:
    base_dir = Path.cwd() / "mcp-memory-data"
    base_dir.mkdir(parents=True, exist_ok=True)

log_dir = base_dir / "logs"
try:
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"mcp_memory_{datetime.now().strftime('%Y%m%d')}.log"
    file_handler = logging.FileHandler(log_file, encoding='utf-8')
except Exception:
    file_handler = logging.StreamHandler()
    log_file = None

logging.basicConfig(
    level=os.getenv('LOG_LEVEL', 'INFO'),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        file_handler,
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)
if log_file:
    logger.info(f"Log file: {log_file}")

# Initialize database and managers
data_dir = base_dir / "data"
data_dir.mkdir(exist_ok=True)
db_path = data_dir / "mcp_memory.db"

db_manager = DatabaseManager(str(db_path))
memory_manager = MemoryManager(db_manager, embedding_model_name=os.getenv('EMBEDDING_MODEL'))
convention_learner = ProjectConventionLearner(memory_manager, db_manager)

mcp = FastMCP("mcp-memory")


@mcp.tool()
def health_check() -> dict:
    """
    Check server health and database connectivity.
    
    Returns:
        Dictionary with health status, database info, embeddings status, and metrics
    """
    with OperationTimer("health_check"):
        try:
            # Check database
            db_ok = db_manager.connection and db_manager.connection.execute("SELECT 1").fetchone()
            db_stats = db_manager.get_database_stats() if db_ok else {}
            
            # Update health metrics
            metrics_collector = get_metrics_collector()
            metrics_collector.update_health_status(
                database_connected=db_ok,
                database_healthy=db_ok,
                embeddings_available=memory_manager.embeddings_available,
                embeddings_loaded=memory_manager._embeddings_loaded,
                memory_count=db_stats.get('memories_count', 0),
                project_count=db_stats.get('projects_count', 0)
            )

            health_data = {
                "database": {
                    "connected": db_ok,
                    "size_mb": round(db_stats.get('database_size_bytes', 0) / (1024 * 1024), 2),
                    "projects": db_stats.get('projects_count', 0),
                    "memories": db_stats.get('memories_count', 0),
                    "relationships": db_stats.get('knowledge_relationships_count', 0),
                    "sessions": db_stats.get('sessions_count', 0),
                },
                "embeddings": {
                    "available": memory_manager.embeddings_available,
                    "loaded": memory_manager._embeddings_loaded,
                    "model": memory_manager.embedding_model_name if memory_manager.embeddings_available else None,
                },
            }
            
            return health_response(
                database_ok=db_ok,
                embeddings_available=memory_manager.embeddings_available,
                embeddings_loaded=memory_manager._embeddings_loaded,
                **health_data
            )
        except Exception as e:
            logger.error(f"Health check failed: {e}", exc_info=True)
            return error_response(str(e), code="HEALTH_CHECK_FAILED")


@mcp.tool()
def get_database_stats() -> dict:
    """
    Get comprehensive database statistics.
    
    Includes counts of all entities, database size, and memory statistics.
    
    Returns:
        Dictionary with database statistics
    """
    with OperationTimer("get_database_stats"):
        try:
            stats = db_manager.get_database_stats()
            stats['database_size_mb'] = round(stats.get('database_size_bytes', 0) / (1024 * 1024), 2)
            stats['generated_at'] = datetime.now().isoformat()
            return {"status": "success", "data": stats}
        except Exception as e:
            logger.error(f"Failed to get database stats: {e}", exc_info=True)
            return {"error": f"Failed to get database stats: {str(e)}", "code": "DB_STATS_FAILED"}


@mcp.tool()
def get_metrics() -> dict:
    """
    Get comprehensive system metrics and performance statistics.
    
    Includes operation metrics, success rates, and performance timings.
    
    Returns:
        Dictionary with complete metrics summary
    """
    with OperationTimer("get_metrics"):
        try:
            metrics_collector = get_metrics_collector()
            summary = metrics_collector.get_summary()
            return {
                "status": "success",
                "data": summary,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Failed to get metrics: {e}", exc_info=True)
            return {"error": f"Failed to get metrics: {str(e)}", "code": "METRICS_FAILED"}


@mcp.tool()
def cleanup_old_data(days_old: int = 30) -> dict:
    """Clean up old memories."""
    try:
        results = db_manager.cleanup_old_data(days_old)
        return {
            "days_threshold": days_old,
            "memories_deleted": results.get("memories_deleted", 0),
            "cleanup_date": datetime.now().isoformat()
        }
    except Exception as e:
        return {"error": f"Cleanup failed: {str(e)}"}


@mcp.tool()
def optimize_memories() -> dict:
    """Analyze and optimize memory storage."""
    try:
        results = db_manager.optimize_memories()
        return {
            "duplicates_merged": results.get("duplicates_merged", 0),
            "orphaned_relationships_removed": results.get("orphaned_relationships", 0),
            "optimization_complete": True,
            "optimization_date": datetime.now().isoformat()
        }
    except Exception as e:
        return {"error": f"Memory optimization failed: {str(e)}"}


@mcp.tool()
def add_memory(content: str, memory_type: str = "conversation", importance: float = 0.5, tags: Optional[List[str]] = None, cwd: Optional[str] = None) -> dict:
    """Add a memory to the current project."""
    try:
        memory_manager.ensure_session(cwd)
        memory_id = memory_manager.add_context_memory(
            content=content,
            memory_type=memory_type,
            importance=importance,
            tags=tags
        )
        return {"memory_id": memory_id}
    except Exception as e:
        return {"error": f"Failed to add memory: {str(e)}"}


@mcp.tool()
def search_memories(query: str, limit: int = 10, offset: int = 0, cwd: Optional[str] = None) -> dict:
    """
    Search memories for the current project using full-text search with pagination.
    
    Args:
        query: Search query
        limit: Maximum results per page (1-1000, default 10)
        offset: Results to skip for pagination
        cwd: Working directory context (optional)
        
    Returns:
        Dictionary with search results, pagination info, and total count
    """
    with OperationTimer("search_memories"):
        try:
            memory_manager.ensure_session(cwd)
            results, total_count = memory_manager.db.search_memories(
                query, memory_manager.current_project_id, limit=limit, offset=offset
            )
            return search_response(results, total_count, query, search_method="text", limit=limit, offset=offset)
        except Exception as e:
            logger.error(f"Search failed: {e}", exc_info=True)
            return error_response(str(e), code="SEARCH_FAILED")


@mcp.tool()
def search_semantic_memories(query: str, limit: int = 10, offset: int = 0, 
                            min_similarity: Optional[float] = None, cwd: Optional[str] = None) -> dict:
    """
    Search memories using semantic similarity with automatic text search fallback and pagination.
    
    Args:
        query: Search query
        limit: Maximum results per page (1-1000, default 10)
        offset: Results to skip for pagination
        min_similarity: Minimum similarity threshold (0.0-1.0, default: 0.3).
                       Lower values return more results with lower confidence.
        cwd: Working directory for project context (optional)
        
    Returns:
        Dictionary with search results, pagination info, and search method used
    """
    with OperationTimer("search_semantic_memories"):
        try:
            memory_manager.ensure_session(cwd)
            # Note: semantic search still returns all results, we paginate here
            results = memory_manager.search_memories_semantic(query, limit=limit + offset, min_similarity=min_similarity)
            
            # Manually paginate since semantic returns all at once
            paginated = results[offset:offset + limit]
            total_count = len(results)
            search_method = results[0].get('search_method', 'semantic') if results else 'semantic'
            
            return search_response(paginated, total_count, query, search_method=search_method, limit=limit, offset=offset)
        except Exception as e:
            logger.error(f"Semantic search failed: {e}", exc_info=True)
            return error_response(str(e), code="SEMANTIC_SEARCH_FAILED")


@mcp.tool()
def get_memory_context(query: str = "", cwd: Optional[str] = None) -> str:
    """Get current memory context, including project conventions."""
    try:
        memory_manager.ensure_session(cwd)
        context = memory_manager.get_memory_context(query)
        conventions = convention_learner.get_project_conventions_summary()
        parts = [context, conventions]
        return "\n\n".join(part for part in parts if part and "No project conventions" not in part)
    except Exception as e:
        return f"Error retrieving context: {str(e)}"


@mcp.tool()
def get_project_summary(cwd: Optional[str] = None) -> dict:
    """Get summary of the current project."""
    try:
        memory_manager.ensure_session(cwd)
        summary = db_manager.get_project_summary(memory_manager.current_project_id)
        return summary
    except Exception as e:
        return {"error": f"Error getting project summary: {str(e)}"}


@mcp.tool()
def auto_learn_project_conventions(project_path: Optional[str] = None, cwd: Optional[str] = None, force_refresh: bool = False) -> dict:
    """
    Automatically learn and remember project-specific conventions.
    
    Scans the project to detect type, tools, build commands, test runners, and deployment patterns.
    Caches results for future reference. Use force_refresh=true to rescan even if cached.
    
    Args:
        project_path: Specific project path to scan (optional)
        cwd: Working directory context (optional)
        force_refresh: Force re-scanning even if already learned
        
    Returns:
        Dictionary with detected conventions and statistics
    """
    with OperationTimer("auto_learn_project_conventions"):
        try:
            memory_manager.ensure_session(cwd)
            target_path = project_path or os.getcwd()
            conventions = convention_learner.auto_learn_project_conventions(target_path, force_refresh=force_refresh)
            return {
                "status": "success",
                "data": {
                    "project_type": conventions.get('project_type', 'unknown'),
                    "environment": {
                        "os": conventions.get('environment', {}).get('os'),
                        "shell": conventions.get('environment', {}).get('shell'),
                        "python_version": conventions.get('environment', {}).get('python_version')
                    },
                    "commands_learned": len(conventions.get('commands', {})),
                    "tools_detected": list(conventions.get('tools', {}).keys()),
                    "package_manager": conventions.get('dependencies', {}).get('package_manager'),
                    "ci_cd": conventions.get('tools', {}).get('ci_cd'),
                    "testing_framework": conventions.get('testing', {}).get('framework'),
                }
            }
        except Exception as e:
            logger.error(f"Error learning project conventions: {e}", exc_info=True)
            return {"error": f"Error learning project conventions: {str(e)}", "code": "CONVENTIONS_LEARNING_FAILED"}


@mcp.tool()
def get_project_conventions(cwd: Optional[str] = None) -> str:
    """Get current project conventions for AI context."""
    try:
        memory_manager.ensure_session(cwd)
        return convention_learner.get_project_conventions_summary()
    except Exception as e:
        return f"Error getting project conventions: {str(e)}"


@mcp.tool()
def suggest_correct_command(user_command: str, cwd: Optional[str] = None) -> dict:
    """Suggest correct project-specific command based on learned conventions."""
    try:
        memory_manager.ensure_session(cwd)
        suggestion = convention_learner.suggest_correct_command(user_command)
        if suggestion:
            return {"original_command": user_command, "suggestion": suggestion}
        return {
            "original_command": user_command,
            "suggestion": "No specific correction found. Command appears acceptable for this project."
        }
    except Exception as e:
        return {"error": f"Error suggesting command correction: {str(e)}"}


@mcp.tool()
def remember_project_pattern(pattern_type: str, pattern_name: str, pattern_content: str, importance: float = 0.8, cwd: Optional[str] = None) -> dict:
    """Remember a project pattern or convention."""
    try:
        memory_manager.ensure_session(cwd)
        memory_content = f"""Project Pattern: {pattern_name}
Type: {pattern_type}

{pattern_content}

This is a project-specific pattern that should be followed consistently.
"""
        memory_id = memory_manager.add_context_memory(
            content=memory_content,
            memory_type="pattern",
            importance=importance,
            tags=[pattern_type, "pattern", "convention", pattern_name.lower().replace(' ', '-')]
        )
        return {"memory_id": memory_id, "pattern_name": pattern_name}
    except Exception as e:
        return {"error": f"Error remembering project pattern: {str(e)}"}


@mcp.tool()
def add_working_memory(slot: str, value: str, cwd: Optional[str] = None) -> dict:
    """Store working memory for the current project."""
    try:
        memory_manager.ensure_session(cwd)
        memory_id = memory_manager.add_working_memory(slot=slot, value=value)
        return {"memory_id": memory_id, "slot": slot}
    except Exception as e:
        return {"error": f"Failed to add working memory: {str(e)}"}


@mcp.tool()
def add_semantic_memory(content: str, importance: float = 0.8, tags: Optional[List[str]] = None, cwd: Optional[str] = None) -> dict:
    """Store durable semantic knowledge or facts."""
    try:
        memory_manager.ensure_session(cwd)
        memory_id = memory_manager.add_semantic_memory(content=content, importance=importance, tags=tags)
        return {"memory_id": memory_id}
    except Exception as e:
        return {"error": f"Failed to add semantic memory: {str(e)}"}


@mcp.tool()
def add_episodic_memory(content: str, tags: Optional[List[str]] = None, cwd: Optional[str] = None) -> dict:
    """Store an episodic memory about something that happened."""
    try:
        memory_manager.ensure_session(cwd)
        memory_id = memory_manager.add_episodic_memory(content=content, tags=tags)
        return {"memory_id": memory_id}
    except Exception as e:
        return {"error": f"Failed to add episodic memory: {str(e)}"}


@mcp.tool()
def add_procedural_memory(content: str, importance: float = 0.8, tags: Optional[List[str]] = None, cwd: Optional[str] = None) -> dict:
    """Store procedural knowledge (how to do something)."""
    try:
        memory_manager.ensure_session(cwd)
        memory_id = memory_manager.add_procedural_memory(content=content, importance=importance, tags=tags)
        return {"memory_id": memory_id}
    except Exception as e:
        return {"error": f"Failed to add procedural memory: {str(e)}"}


_learn_thread: threading.Thread | None = None

def initialize_session():
    """Initialize session from current working directory and auto-learn conventions."""
    global _learn_thread
    try:
        project_path = os.getcwd()
        memory_manager.start_session(project_path)
        logger.info(f"Session initialized for: {project_path}")

        def _learn():
            try:
                convention_learner.auto_learn_project_conventions(project_path)
                logger.info(f"Auto-learned conventions for: {project_path}")
            except Exception as e:
                logger.warning(f"Auto-learn conventions failed: {e}")

        _learn_thread = threading.Thread(target=_learn, daemon=True)
        _learn_thread.start()
    except Exception as e:
        logger.error(f"Failed to initialize session: {e}")


def main():
    """Main server entry point."""
    try:
        logger.info("MCP Memory Server starting...")
        logger.info(f"Database: {db_path}")
        initialize_session()
        logger.info("Starting MCP server loop...")
        mcp.run()
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Server error: {e}", exc_info=True)
        raise
    finally:
        if db_manager:
            db_manager.close()
        logger.info("MCP Memory Server stopped")


if __name__ == "__main__":
    main()
