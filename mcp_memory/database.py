"""
SQLite3 Database Manager for MCP Memory
Handles projects, memories, knowledge relationships, sessions, and context layers.
"""

import sqlite3
from sqlite3 import Cursor
import json
import uuid
import time
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Any, Union
from pathlib import Path
import logging
from functools import wraps

from .exceptions import DatabaseException


def retry_on_failure(max_retries: int = 3, delay: float = 1.0):
    """Decorator to retry database operations on failure with exponential backoff."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if attempt == max_retries - 1:
                        raise
                    logging.warning(f"Attempt {attempt + 1} failed: {e}. Retrying in {delay}s...")
                    time.sleep(delay * (2 ** attempt))
            return None
        return wrapper
    return decorator


class DatabaseManager:
    def __init__(self, db_path: str = "mcp_memory.db"):
        """
        Initialize database connection and create tables.
        
        Args:
            db_path: Path to SQLite database file (default: "mcp_memory.db")
            
        Raises:
            DatabaseException: If initialization fails
        """
        self.db_path = db_path
        self.connection: Optional[sqlite3.Connection] = None
        self.setup_database()

    def _check_connection(self) -> bool:
        if not self.connection:
            logging.error("Database connection not established")
            return False
        return True

    def setup_database(self) -> None:
        """
        Set up database connection with proper configuration.
        
        Raises:
            DatabaseException: If database connection or initialization fails
        """
        try:
            self.connection = sqlite3.connect(self.db_path, check_same_thread=False)
            self.connection.row_factory = sqlite3.Row
            self.create_tables()
            logging.info(f"Database initialized successfully at {self.db_path}")
        except sqlite3.DatabaseError as e:
            logging.error(f"SQLite database error during setup: {e}", exc_info=True)
            raise DatabaseException(f"Failed to initialize database at {self.db_path}: {e}") from e
        except Exception as e:
            logging.error(f"Unexpected error during database setup: {e}", exc_info=True)
            raise DatabaseException(f"Failed to initialize database: {e}") from e

    def create_tables(self) -> None:
        """
        Create database schema with migrations support.
        
        Raises:
            DatabaseException: If table creation fails
        """
        if not self._check_connection() or not self.connection:
            raise DatabaseException("Database connection not established")

        cursor: Cursor = self.connection.cursor()

        try:
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT UNIQUE NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata TEXT
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding_vector TEXT,
                content_hash TEXT,
                file_path TEXT,
                importance_score REAL DEFAULT 0.5,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                accessed_count INTEGER DEFAULT 0,
                last_accessed TIMESTAMP,
                tags TEXT,
                metadata TEXT,
                FOREIGN KEY (project_id) REFERENCES projects(id)
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS knowledge_relationships (
                id TEXT PRIMARY KEY,
                from_type TEXT NOT NULL,
                from_id TEXT NOT NULL,
                to_type TEXT NOT NULL,
                to_id TEXT NOT NULL,
                relationship_type TEXT NOT NULL,
                strength REAL DEFAULT 1.0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata TEXT
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP,
                interaction_count INTEGER DEFAULT 0,
                context_summary TEXT,
                FOREIGN KEY (project_id) REFERENCES projects(id)
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS context_layers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                query_pattern TEXT,
                priority INTEGER DEFAULT 1,
                is_active BOOLEAN DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """)

            # Create indexes for performance
            indexes = [
                ("idx_memories_project_id", "CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id)"),
                ("idx_memories_type", "CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)"),
                ("idx_memories_importance", "CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score DESC)"),
                ("idx_memories_created_at", "CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC)"),
                ("idx_memories_last_accessed", "CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed DESC)"),
                ("idx_memories_content_hash", "CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)"),
                ("idx_memories_file_path", "CREATE INDEX IF NOT EXISTS idx_memories_file_path ON memories(file_path)"),
                ("idx_memories_accessed_count", "CREATE INDEX IF NOT EXISTS idx_memories_accessed_count ON memories(accessed_count DESC)"),
                ("idx_memories_composite", "CREATE INDEX IF NOT EXISTS idx_memories_composite ON memories(project_id, type, importance_score DESC)"),
                ("idx_relationships_from", "CREATE INDEX IF NOT EXISTS idx_relationships_from ON knowledge_relationships(from_type, from_id)"),
                ("idx_relationships_to", "CREATE INDEX IF NOT EXISTS idx_relationships_to ON knowledge_relationships(to_type, to_id)"),
                ("idx_relationships_type", "CREATE INDEX IF NOT EXISTS idx_relationships_type ON knowledge_relationships(relationship_type)"),
                ("idx_relationships_strength", "CREATE INDEX IF NOT EXISTS idx_relationships_strength ON knowledge_relationships(strength DESC)"),
                ("idx_sessions_project_id", "CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id)"),
                ("idx_sessions_started_at", "CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC)"),
                ("idx_context_layers_active", "CREATE INDEX IF NOT EXISTS idx_context_layers_active ON context_layers(is_active)"),
                ("idx_context_layers_priority", "CREATE INDEX IF NOT EXISTS idx_context_layers_priority ON context_layers(priority DESC)"),
            ]

            for idx_name, idx_sql in indexes:
                try:
                    cursor.execute(idx_sql)
                except sqlite3.OperationalError as e:
                    logging.warning(f"Index {idx_name} creation skipped: {e}")

            # Set up FTS5 virtual table
            try:
                cursor.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                    title,
                    content,
                    content='memories',
                    content_rowid='rowid'
                )
                """)

                # Create triggers for FTS5 synchronization
                cursor.execute("""
                CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
                    INSERT INTO memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
                END
                """)

                cursor.execute("""
                CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
                    INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
                END
                """)

                logging.info("FTS5 full-text search enabled")
            except sqlite3.OperationalError as e:
                logging.warning(f"FTS5 setup skipped (optional): {e}")

            self.connection.commit()
            logging.info("Database schema created/verified successfully")

            # Run schema migrations
            self._migrate_schema(cursor)
            self.connection.commit()

        except sqlite3.DatabaseError as e:
            self.connection.rollback()
            logging.error(f"Database error during table creation: {e}", exc_info=True)
            raise DatabaseException(f"Failed to create database tables: {e}") from e
        except Exception as e:
            self.connection.rollback()
            logging.error(f"Unexpected error during table creation: {e}", exc_info=True)
            raise DatabaseException(f"Failed to create database schema: {e}") from e

    def _migrate_schema(self, cursor: Cursor) -> None:
        """
        Apply schema migrations for database upgrades.
        
        Migrations are applied before table creation is finalized.
        
        Args:
            cursor: Database cursor to use for migrations
        """
        try:
            cursor.execute("PRAGMA table_info(memories)")
            columns = {row[1] for row in cursor.fetchall()}

            migrations = [
                ("content_hash", "ALTER TABLE memories ADD COLUMN content_hash TEXT", "Added content_hash column"),
                ("file_path", "ALTER TABLE memories ADD COLUMN file_path TEXT", "Added file_path column"),
                ("embedding_vector", "ALTER TABLE memories ADD COLUMN embedding_vector TEXT", "Added embedding_vector column"),
            ]

            for column_name, migration_sql, message in migrations:
                if column_name not in columns:
                    try:
                        cursor.execute(migration_sql)
                        logging.info(f"Schema migration: {message}")
                    except sqlite3.OperationalError as e:
                        logging.warning(f"Migration for {column_name} skipped: {e}")

        except sqlite3.OperationalError as e:
            logging.warning(f"Schema info check failed: {e}")

    @retry_on_failure()
    def get_or_create_project(self, name: str, path: str, description: Optional[str] = None) -> str:
        """
        Get existing project by path or create a new one.
        
        Projects are uniquely identified by their filesystem path.
        
        Args:
            name: Project name
            path: Absolute project path (must be unique)
            description: Optional project description
            
        Returns:
            Project ID string
            
        Raises:
            DatabaseException: If project creation fails
        """
        if not self._check_connection() or not self.connection:
            raise DatabaseException("Database connection not established")

        if not path:
            raise DatabaseException("Project path cannot be empty")
            
        cursor: Cursor = self.connection.cursor()
        try:
            cursor.execute("SELECT id FROM projects WHERE path = ?", (path,))
            result = cursor.fetchone()
            if result:
                logging.debug(f"Using existing project at {path}")
                return result['id']

            project_id = str(uuid.uuid4())
            cursor.execute("""
            INSERT INTO projects (id, name, path, description)
            VALUES (?, ?, ?, ?)
            """, (project_id, name, path, description))
            self.connection.commit()
            logging.info(f"Created new project: {name} at {path}")
            return project_id
        except sqlite3.IntegrityError as e:
            logging.error(f"Integrity error creating project {name}: {e}", exc_info=True)
            raise DatabaseException(f"Project creation failed (duplicate path?): {e}") from e
        except Exception as e:
            logging.error(f"Error creating/retrieving project: {e}", exc_info=True)
            raise DatabaseException(f"Failed to get or create project: {e}") from e

    @retry_on_failure()
    def add_memory(self, project_id: str, memory_type: str, title: str, content: str,
                   tags: Optional[List[str]] = None, importance_score: float = 0.5,
                   metadata: Optional[Dict[str, Any]] = None) -> str:
        """
        Add a new memory to the database.
        
        Args:
            project_id: Project ID this memory belongs to
            memory_type: Type of memory (semantic, episodic, procedural, etc.)
            title: Memory title
            content: Memory content
            tags: Optional list of tags
            importance_score: Importance score (0.0-1.0)
            metadata: Optional metadata dict
            
        Returns:
            Memory ID
            
        Raises:
            DatabaseException: If memory creation fails
        """
        if not self._check_connection() or not self.connection:
            raise DatabaseException("Database connection not established")

        if not project_id or not title or not content:
            raise DatabaseException("project_id, title, and content are required")
            
        if importance_score < 0.0 or importance_score > 1.0:
            logging.warning(f"Importance score out of range: {importance_score}, clamping to 0.0-1.0")
            importance_score = max(0.0, min(1.0, importance_score))

        cursor: Cursor = self.connection.cursor()
        memory_id = str(uuid.uuid4())

        try:
            cursor.execute("""
            INSERT INTO memories (id, project_id, type, title, content, importance_score, tags, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                memory_id, project_id, memory_type, title, content,
                importance_score, json.dumps(tags or []), json.dumps(metadata or {})
            ))
            self.connection.commit()
            logging.info(f"Created memory {memory_id} of type {memory_type} for project {project_id}")
            return memory_id
        except sqlite3.IntegrityError as e:
            logging.error(f"Integrity error adding memory: {e}", exc_info=True)
            raise DatabaseException(f"Failed to add memory (integrity violation): {e}") from e
        except Exception as e:
            logging.error(f"Error adding memory: {e}", exc_info=True)
            raise DatabaseException(f"Failed to add memory: {e}") from e

    @retry_on_failure()
    def get_memories(self, project_id: Optional[str] = None, memory_type: Optional[str] = None,
                     limit: int = 50, offset: int = 0, sort_by: str = "created_at") -> tuple[List[Dict[str, Any]], int]:
        """
        Retrieve memories with optional filters and pagination.
        
        Args:
            project_id: Filter by project ID
            memory_type: Filter by memory type
            limit: Number of results per page (max 1000, default 50)
            offset: Number of results to skip (for pagination)
            sort_by: Sort column (must be in whitelist)
            
        Returns:
            Tuple of (memories list, total count)
            
        Raises:
            DatabaseException: If query fails
        """
        if not self._check_connection() or not self.connection:
            raise DatabaseException("Database connection not established")

        # Validate and clamp limit
        limit = max(1, min(limit, 1000))  # Between 1 and 1000
        offset = max(0, offset)  # Non-negative

        allowed_sort = {
            "created_at", "updated_at", "importance_score", "last_accessed",
            "accessed_count", "type", "title"
        }
        sort_column = sort_by if sort_by in allowed_sort else "created_at"

        cursor: Cursor = self.connection.cursor()

        try:
            # Build count query
            count_query = "SELECT COUNT(*) as count FROM memories WHERE 1=1"
            params: List[Any] = []

            if project_id:
                count_query += " AND project_id = ?"
                params.append(project_id)

            if memory_type:
                count_query += " AND type = ?"
                params.append(memory_type)

            # Get total count
            cursor.execute(count_query, params)
            total_count = cursor.fetchone()['count']

            # Build data query with pagination
            query = "SELECT * FROM memories WHERE 1=1"
            
            if project_id:
                query += " AND project_id = ?"
            if memory_type:
                query += " AND type = ?"

            query += f" ORDER BY {sort_column} DESC LIMIT ? OFFSET ?"
            params.append(limit)
            params.append(offset)

            cursor.execute(query, params)
            results = [dict(row) for row in cursor.fetchall()]
            
            logging.debug(f"Retrieved {len(results)} memories (total: {total_count}, offset: {offset})")
            return results, total_count
            
        except Exception as e:
            logging.error(f"Error retrieving memories: {e}", exc_info=True)
            raise DatabaseException(f"Failed to retrieve memories: {e}") from e

    def search_memories(self, query: str, project_id: Optional[str] = None, limit: int = 10, 
                       offset: int = 0) -> tuple[List[Dict[str, Any]], int]:
        """
        Search memories using FTS5 or LIKE fallback with pagination.
        
        Args:
            query: Search query
            project_id: Filter by project ID
            limit: Maximum results (max 1000)
            offset: Results to skip
            
        Returns:
            Tuple of (results list, total count)
        """
        if not self._check_connection() or not self.connection:
            return [], 0

        # Validate pagination params
        limit = max(1, min(limit, 1000))
        offset = max(0, offset)

        cursor: Cursor = self.connection.cursor()

        try:
            # Try FTS5 first
            if project_id:
                # Count query for FTS5
                cursor.execute("""
                SELECT COUNT(*) as count FROM memories m
                JOIN memories_fts fts ON m.rowid = fts.rowid
                WHERE memories_fts MATCH ? AND m.project_id = ?
                """, (query, project_id))
            else:
                cursor.execute("""
                SELECT COUNT(*) as count FROM memories m
                JOIN memories_fts fts ON m.rowid = fts.rowid
                WHERE memories_fts MATCH ?
                """, (query,))

            total_count = cursor.fetchone()['count']

            # Get paginated results
            if project_id:
                cursor.execute("""
                SELECT m.* FROM memories m
                JOIN memories_fts fts ON m.rowid = fts.rowid
                WHERE memories_fts MATCH ? AND m.project_id = ?
                ORDER BY m.importance_score DESC, m.created_at DESC
                LIMIT ? OFFSET ?
                """, (query, project_id, limit, offset))
            else:
                cursor.execute("""
                SELECT m.* FROM memories m
                JOIN memories_fts fts ON m.rowid = fts.rowid
                WHERE memories_fts MATCH ?
                ORDER BY m.importance_score DESC, m.created_at DESC
                LIMIT ? OFFSET ?
                """, (query, limit, offset))

            rows = cursor.fetchall()
            if rows:
                logging.debug(f"FTS5 search found {total_count} results for '{query}' (limit={limit}, offset={offset})")
                return [dict(row) for row in rows], total_count
        except Exception as e:
            logging.debug(f"FTS5 search failed: {e}, falling back to LIKE")

        # LIKE fallback with pagination
        try:
            # Count query
            count_query = "SELECT COUNT(*) as count FROM memories WHERE (title LIKE ? OR content LIKE ?)"
            params = [f"%{query}%", f"%{query}%"]

            if project_id:
                count_query += " AND project_id = ?"
                params.append(project_id)

            cursor.execute(count_query, params)
            total_count = cursor.fetchone()['count']

            # Get paginated results
            search_query = """
            SELECT * FROM memories
            WHERE (title LIKE ? OR content LIKE ?)
            """
            search_params = [f"%{query}%", f"%{query}%"]

            if project_id:
                search_query += " AND project_id = ?"
                search_params.append(project_id)

            search_query += " ORDER BY importance_score DESC, created_at DESC LIMIT ? OFFSET ?"
            search_params.extend([limit, offset])

            cursor.execute(search_query, search_params)
            rows = cursor.fetchall()
            
            logging.debug(f"LIKE search found {total_count} results for '{query}' (limit={limit}, offset={offset})")
            return [dict(row) for row in rows], total_count
            
        except Exception as e:
            logging.error(f"Search failed: {e}", exc_info=True)
            return [], 0

    def update_memory_access(self, memory_id: str) -> None:
        """Update memory access count and timestamp."""
        if not self._check_connection() or not self.connection:
            return

        try:
            cursor: Cursor = self.connection.cursor()
            if not cursor:
                return

            cursor.execute("SELECT accessed_count FROM memories WHERE id = ?", (memory_id,))
            result = cursor.fetchone()
            if not result:
                return

            current_count = int(result['accessed_count']) if result['accessed_count'] else 0
            new_count = current_count + 1

            cursor.execute("""
            UPDATE memories
            SET accessed_count = ?, last_accessed = CURRENT_TIMESTAMP
            WHERE id = ?
            """, (new_count, memory_id))
            self.connection.commit()
        except Exception as e:
            logging.error(f"Error updating memory access: {e}")

    def get_project_summary(self, project_id: str) -> Dict[str, Union[Dict[str, str], str]]:
        """Get a summary of project statistics."""
        if not self._check_connection() or not self.connection:
            return {
                "project": {},
                "memory_counts": {},
                "total_memories": "0"
            }

        cursor: Cursor = self.connection.cursor()
        if not cursor:
            return {
                "project": {},
                "memory_counts": {},
                "total_memories": "0"
            }

        cursor.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
        project = {str(k): str(v) if v is not None else "" for k, v in dict(cursor.fetchone() or {}).items()}

        cursor.execute("""
            SELECT type, CAST(COUNT(*) AS TEXT) as count FROM memories
            WHERE project_id = ? GROUP BY type
            """, (project_id,))
        memory_counts = {str(row['type']): str(row['count']) for row in cursor.fetchall()}

        total_memories = str(sum(int(count) for count in memory_counts.values()))

        return {
            "project": project,
            "memory_counts": memory_counts,
            "total_memories": total_memories
        }

    def add_relationship(self, from_type: str, from_id: str, to_type: str,
                        to_id: str, relationship_type: str, strength: float = 1.0) -> str:
        """Add a relationship in the knowledge graph."""
        if not self._check_connection() or not self.connection:
            return ""

        cursor: Cursor = self.connection.cursor()
        rel_id = str(uuid.uuid4())

        cursor.execute("""
        INSERT INTO knowledge_relationships
        (id, from_type, from_id, to_type, to_id, relationship_type, strength)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (rel_id, from_type, from_id, to_type, to_id, relationship_type, strength))
        self.connection.commit()
        return rel_id

    def get_related_items(self, item_type: str, item_id: str) -> List[Dict[str, Any]]:
        """Get all items related to a specific item."""
        if not self._check_connection() or not self.connection:
            return []

        cursor: Cursor = self.connection.cursor()
        cursor.execute("""
        SELECT * FROM knowledge_relationships
        WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
        ORDER BY strength DESC
        """, (item_type, item_id, item_type, item_id))
        return [dict(row) for row in cursor.fetchall()]

    def add_session(self, project_id: str) -> str:
        """
        Create a new session for a project.
        
        Args:
            project_id: Project ID to create session for
            
        Returns:
            Session ID
            
        Raises:
            DatabaseException: If session creation fails
        """
        if not self._check_connection() or not self.connection:
            raise DatabaseException("Database connection not established")

        if not project_id:
            raise DatabaseException("project_id cannot be empty")

        session_id = str(uuid.uuid4())
        cursor: Cursor = self.connection.cursor()
        
        try:
            cursor.execute("""
            INSERT INTO sessions (id, project_id)
            VALUES (?, ?)
            """, (session_id, project_id))
            self.connection.commit()
            logging.info(f"Created session {session_id} for project {project_id}")
            return session_id
        except sqlite3.IntegrityError as e:
            logging.error(f"Integrity error creating session: {e}", exc_info=True)
            raise DatabaseException(f"Failed to create session (invalid project?): {e}") from e
        except Exception as e:
            logging.error(f"Error creating session: {e}", exc_info=True)
            raise DatabaseException(f"Failed to create session: {e}") from e

    def update_session(self, session_id: str, ended_at: Optional[str] = None,
                       context_summary: Optional[str] = None) -> bool:
        """Update session metadata."""
        if not self._check_connection() or not self.connection:
            return False

        cursor: Cursor = self.connection.cursor()
        cursor.execute("""
        UPDATE sessions SET ended_at = ?, context_summary = ?
        WHERE id = ?
        """, (ended_at, context_summary, session_id))
        self.connection.commit()
        return cursor.rowcount > 0

    # ==================== CLEANUP AND OPTIMIZATION ====================

    def cleanup_old_data(self, days_old: int = 30) -> Dict[str, int]:
        """Clean up old memories with low importance."""
        if not self._check_connection() or not self.connection:
            return {"memories_deleted": 0}

        try:
            cutoff_date = datetime.now() - timedelta(days=days_old)
            cursor: Cursor = self.connection.cursor()

            cursor.execute("""
                DELETE FROM memories
                WHERE created_at < ? AND importance_score < 0.3
            """, (cutoff_date,))
            memories_deleted = cursor.rowcount

            self.connection.commit()
            return {"memories_deleted": memories_deleted}
        except Exception as e:
            logging.error(f"Error during cleanup: {e}")
            return {"memories_deleted": 0}

    def optimize_memories(self) -> Dict[str, int]:
        """Analyze and optimize memory storage by removing duplicates."""
        if not self._check_connection() or not self.connection:
            return {"duplicates_merged": 0, "orphaned_relationships": 0}

        try:
            cursor: Cursor = self.connection.cursor()

            cursor.execute("""
                SELECT content, COUNT(*) as count, GROUP_CONCAT(id) as ids
                FROM memories
                GROUP BY content
                HAVING count > 1
            """)

            duplicates = cursor.fetchall()
            merged_count = 0

            for dup in duplicates:
                ids = dup['ids'].split(',')
                if len(ids) > 1:
                    ids_to_delete = ids[1:]
                    placeholders = ','.join(['?'] * len(ids_to_delete))
                    cursor.execute(f"""
                        DELETE FROM memories
                        WHERE id IN ({placeholders})
                    """, ids_to_delete)
                    merged_count += cursor.rowcount

            cursor.execute("""
                DELETE FROM knowledge_relationships
                WHERE (from_type = 'memory' AND from_id NOT IN (SELECT id FROM memories))
                   OR (to_type = 'memory' AND to_id NOT IN (SELECT id FROM memories))
            """)
            orphaned_relationships = cursor.rowcount

            self.connection.commit()
            return {
                "duplicates_merged": merged_count,
                "orphaned_relationships": orphaned_relationships
            }
        except Exception as e:
            logging.error(f"Error during optimization: {e}")
            return {"duplicates_merged": 0, "orphaned_relationships": 0}

    def get_database_stats(self) -> Dict[str, Any]:
        """Get comprehensive database statistics."""
        if not self._check_connection() or not self.connection:
            return {}

        try:
            cursor: Cursor = self.connection.cursor()
            stats: Dict[str, Any] = {}

            tables = ('projects', 'memories', 'knowledge_relationships', 'sessions', 'context_layers')
            for table in tables:
                cursor.execute(f"SELECT COUNT(*) as count FROM {table}")
                stats[f"{table}_count"] = cursor.fetchone()['count']

            cursor.execute("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()")
            stats['database_size_bytes'] = cursor.fetchone()['size']

            cursor.execute("""
                SELECT
                    AVG(importance_score) as avg_importance,
                    MAX(accessed_count) as max_accessed,
                    COUNT(DISTINCT type) as memory_types
                FROM memories
            """)
            memory_stats = cursor.fetchone()
            if memory_stats:
                stats.update({
                    'avg_memory_importance': memory_stats['avg_importance'] or 0,
                    'max_memory_accessed': memory_stats['max_accessed'] or 0,
                    'memory_types_count': memory_stats['memory_types'] or 0
                })

            return stats
        except Exception as e:
            logging.error(f"Error getting database stats: {e}")
            return {}

    def close(self) -> None:
        """
        Close database connection safely.
        
        Ensures all pending transactions are committed and connection is properly closed.
        """
        if self.connection:
            try:
                # Commit any pending transactions
                self.connection.commit()
                logging.debug("Committed pending transactions")
            except Exception as e:
                logging.warning(f"Error committing pending transactions: {e}")
            
            try:
                self.connection.close()
                self.connection = None
                logging.info("Database connection closed")
            except Exception as e:
                logging.error(f"Error closing database connection: {e}", exc_info=True)
