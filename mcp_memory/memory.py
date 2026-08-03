"""
Automatic Memory Management for MCP Memory
Handles context tracking, memory creation, retrieval, and semantic search.
"""

import json
import os
import logging
import uuid
import hashlib
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime, timedelta
from pathlib import Path

from .database import DatabaseManager
from .exceptions import EmbeddingException, SessionException, ValidationException
from .types import MemoryRecord, SearchResult
from .classification_config import (
    MEMORY_TYPE_KEYWORDS, IMPORTANCE_MODIFIERS, LENGTH_MODIFIERS,
    MIN_IMPORTANCE, MAX_IMPORTANCE, ALLOWED_MEMORY_TYPES
)
from .validation import validate_content, validate_memory_type, validate_tags, validate_number_range

try:
    from sentence_transformers import SentenceTransformer
    EMBEDDINGS_AVAILABLE = True
except ImportError:
    EMBEDDINGS_AVAILABLE = False
    logging.warning("sentence-transformers not available. Semantic search will be disabled.")

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False
    logging.warning("NumPy not available. Similarity calculations will return 0.")


class MemoryManager:
    """
    Manages all memory operations including storage, retrieval, and semantic search.
    
    Supports multiple memory types, automatic classification, semantic search with fallback,
    and automatic relationship detection between related memories.
    """
    
    def __init__(self, db_manager: DatabaseManager, embedding_model_name: Optional[str] = None,
                 disable_embeddings: bool = False):
        """
        Initialize memory manager.
        
        Args:
            db_manager: Database manager instance
            embedding_model_name: Name of sentence-transformers model to use (default: all-MiniLM-L6-v2).
                Set to None to disable embeddings, or set via EMBEDDING_MODEL env variable.
            disable_embeddings: Force disable embeddings even if available
                
        Raises:
            ValidationException: If db_manager is None
        """
        if not db_manager:
            raise ValidationException("db_manager cannot be None")
            
        self.db = db_manager
        self.current_session_id: Optional[str] = None
        self.current_project_id: Optional[str] = None
        self.context_window: List[Dict[str, Any]] = []
        self.max_context_size = 50

        # Semantic search configuration
        self.disable_embeddings = disable_embeddings
        self.embedding_model_name = embedding_model_name or os.getenv('EMBEDDING_MODEL', 'all-MiniLM-L6-v2')
        self.embedding_model: Optional[Any] = None
        self.embeddings_available = EMBEDDINGS_AVAILABLE and not disable_embeddings
        self._embeddings_loaded = False
        self._embedding_load_attempted = False
        
        # Default similarity threshold (can be overridden per search)
        self.default_similarity_threshold = 0.7
        
        logging.info(f"MemoryManager initialized with embedding model: {self.embedding_model_name if self.embeddings_available else 'DISABLED'}")

    def _ensure_embeddings_loaded(self) -> bool:
        """
        Lazily load embedding model on first use.
        
        Returns:
            True if embeddings are available and loaded, False otherwise
        """
        if not self.embeddings_available:
            logging.debug("Embeddings not available (sentence-transformers not installed)")
            return False
            
        if self._embeddings_loaded:
            return True
            
        if self._embedding_load_attempted:
            # Already tried and failed
            return False
            
        self._embedding_load_attempted = True
        
        try:
            logging.info(f"Loading embedding model: {self.embedding_model_name}")
            self.embedding_model = SentenceTransformer(self.embedding_model_name)
            self._embeddings_loaded = True
            logging.info(f"Successfully loaded embedding model: {self.embedding_model_name}")
            return True
        except Exception as e:
            logging.error(f"Failed to load embedding model {self.embedding_model_name}: {e}", exc_info=True)
            self.embeddings_available = False
            return False

    def start_session(self, cwd: Optional[str] = None) -> str:
        """
        Start a new session for the given working directory.
        
        Args:
            cwd: Current working directory path. If None, uses os.getcwd()
            
        Returns:
            Session ID string
            
        Raises:
            SessionException: If session initialization fails
        """
        if not cwd:
            cwd = os.getcwd()

        project_name = Path(cwd).name or "root"
        project_description = f"Project at {cwd}"

        try:
            self.current_project_id = self.db.get_or_create_project(
                name=project_name,
                path=os.path.abspath(cwd),
                description=project_description
            )

            session_uuid = str(uuid.uuid4())
            self.current_session_id = self.db.add_session(self.current_project_id)

            if not self.current_session_id:
                raise SessionException(f"Failed to create session for project {project_name}")

            self.load_relevant_memories()
            logging.info(f"Started session for project: {project_name} ({cwd})")
            return self.current_session_id
        except Exception as e:
            logging.error(f"Failed to start session for {cwd}: {e}", exc_info=True)
            raise SessionException(f"Session start failed for {cwd}: {e}") from e

    def ensure_session(self, cwd: Optional[str] = None) -> str:
        """Ensure a session is active; start one if needed."""
        if self.current_session_id and self.current_project_id:
            return self.current_session_id
        return self.start_session(cwd)

    def generate_id(self) -> str:
        return str(uuid.uuid4())

    def _generate_content_hash(self, content: str) -> str:
        return hashlib.md5(content.encode('utf-8')).hexdigest()

    def _generate_embedding(self, text: str, force: bool = False) -> Optional[List[float]]:
        """
        Generate embedding vector for text using sentence-transformers.
        
        Uses lazy loading - model is only loaded on first call to this method.
        Falls back gracefully if embeddings are unavailable or disabled.
        
        Args:
            text: Text to generate embedding for
            force: Force generation even if embeddings typically disabled
            
        Returns:
            List of floats representing the embedding, or None if generation fails or disabled
        """
        if self.disable_embeddings and not force:
            logging.debug("Embeddings disabled, skipping generation")
            return None
            
        if not self._ensure_embeddings_loaded():
            logging.debug("Embeddings unavailable, cannot generate embedding")
            return None
            
        try:
            embedding = self.embedding_model.encode(text)
            logging.debug(f"Generated embedding of size {len(embedding)} for text length {len(text)}")
            return embedding.tolist()
        except Exception as e:
            logging.error(f"Failed to generate embedding for text (len={len(text)}): {e}", exc_info=True)
            return None

    def _calculate_similarity(self, embedding1: List[float], embedding2: List[float]) -> float:
        """
        Calculate cosine similarity between two embedding vectors.
        
        Args:
            embedding1: First embedding vector
            embedding2: Second embedding vector
            
        Returns:
            Similarity score between 0.0 and 1.0. Returns 0.0 if calculation fails.
        """
        if not NUMPY_AVAILABLE:
            logging.debug("NumPy unavailable for similarity calculation")
            return 0.0
        try:
            vec1 = np.array(embedding1)
            vec2 = np.array(embedding2)
            similarity = float(np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2)))
            return similarity
        except Exception as e:
            logging.error(f"Error calculating similarity: {e}", exc_info=True)
            return 0.0

    def classify_memory(self, interaction_type: str, content: str) -> Tuple[str, float]:
        """
        Classify memory type and calculate importance score from content.
        
        Classification is based on configurable keywords defined in classification_config.py.
        Importance is calculated from:
        - Base importance for memory type (0.5-0.9)
        - Modifiers for keywords (critical, security, etc.)
        - Content length adjustment
        
        Args:
            interaction_type: Type of interaction (e.g., 'conversation', 'error')
            content: Content to classify
            
        Returns:
            Tuple of (memory_type, importance_score) where importance_score is constrained
            between MIN_IMPORTANCE (0.1) and MAX_IMPORTANCE (1.0)
        """
        if not content:
            return 'conversation', MIN_IMPORTANCE
            
        content_lower = content.lower()
        memory_type = 'conversation'
        importance = 0.5

        # Classify by type
        for type_name, type_config in MEMORY_TYPE_KEYWORDS.items():
            keywords = type_config.get('keywords', ())
            if keywords and any(keyword in content_lower for keyword in keywords):
                memory_type = type_name
                importance = type_config.get('base_importance', 0.5)
                logging.debug(f"Classified as '{memory_type}' based on keywords")
                break

        # Apply importance modifiers
        for keyword, modifier in IMPORTANCE_MODIFIERS.items():
            if keyword in content_lower:
                importance += modifier
                logging.debug(f"Applied importance modifier '{keyword}' (+{modifier})")

        # Apply length modifier
        content_len = len(content)
        for (min_len, max_len), modifier in LENGTH_MODIFIERS.items():
            if min_len <= content_len < max_len:
                importance += modifier
                logging.debug(f"Applied length modifier for {content_len} chars ({modifier:+.2f})")
                break

        # Clamp to valid range
        final_importance = max(MIN_IMPORTANCE, min(MAX_IMPORTANCE, importance))
        
        if final_importance != importance:
            logging.debug(f"Clamped importance from {importance:.2f} to {final_importance:.2f}")
            
        return memory_type, final_importance

    def extract_title(self, content: str, max_length: int = 100) -> str:
        """
        Extract a meaningful title from content.
        
        Uses first line if short enough, otherwise builds title from first words.
        
        Args:
            content: Content to extract title from
            max_length: Maximum title length (default: 100)
            
        Returns:
            Extracted title string
        """
        lines = content.split('\n')
        first_line = lines[0].strip()

        if len(first_line) <= max_length:
            return first_line

        words = first_line.split()
        title = ""
        for word in words:
            if len(title + word) > max_length:
                break
            title += word + " "

        result = title.strip() + "..." if title else content[:max_length] + "..."
        return result

    def add_context_memory(self, content: str, memory_type: Optional[str] = None,
                           importance: Optional[float] = None, tags: Optional[List[str]] = None,
                           file_path: Optional[str] = None) -> str:
        """
        Add a new memory to the database with duplicate detection and auto-classification.
        
        If memory with identical content already exists, increments its access count
        instead of creating a duplicate.
        
        Args:
            content: Memory content (required)
            memory_type: Type of memory. If None, auto-classified. Must be in ALLOWED_MEMORY_TYPES.
            importance: Importance score (0.0-1.0). If None, auto-calculated.
            tags: Optional list of tags
            file_path: Optional file path associated with memory
            
        Returns:
            Memory ID (existing or newly created)
            
        Raises:
            SessionException: If no active project session
            ValidationException: If content is empty or invalid
        """
        if not self.current_project_id:
            raise SessionException("No active project. Call start_session first.")
        
        # Validate input
        content = validate_content(content, min_length=1, max_length=1000000)
        
        if tags is not None:
            tags = validate_tags(tags)

        # Check for duplicates
        content_hash = self._generate_content_hash(content)
        cursor = self.db.connection.cursor()
        cursor.execute("""
        SELECT id FROM memories WHERE project_id = ? AND content_hash = ?
        """, (self.current_project_id, content_hash))

        existing = cursor.fetchone()
        if existing:
            logging.info(f"Duplicate content detected, updating access count for memory {existing['id']}")
            cursor.execute("""
            UPDATE memories SET accessed_count = accessed_count + 1, last_accessed = ?
            WHERE id = ?
            """, (datetime.now().isoformat(), existing['id']))
            self.db.connection.commit()
            return existing['id']

        # Auto-classify if needed
        if memory_type is None or importance is None:
            classified_type, classified_importance = self.classify_memory('interaction', content)
            memory_type = memory_type or classified_type
            importance = importance if importance is not None else classified_importance

        # Validate memory type
        try:
            memory_type = validate_memory_type(memory_type)
        except ValidationException as e:
            logging.warning(f"Invalid memory type, using 'conversation': {e}")
            memory_type = 'conversation'
        
        # Validate importance
        try:
            importance = validate_number_range(importance, min_val=MIN_IMPORTANCE, max_val=MAX_IMPORTANCE, 
                                              name="importance")
        except ValidationException as e:
            logging.warning(f"Invalid importance, clamping: {e}")
            importance = max(MIN_IMPORTANCE, min(MAX_IMPORTANCE, importance))

        title = self.extract_title(content)
        embedding = self._generate_embedding(content)
        embedding_json = json.dumps(embedding) if embedding else None

        memory_id = self.generate_id()
        try:
            cursor.execute("""
            INSERT INTO memories (id, project_id, type, title, content, embedding_vector,
                                content_hash, file_path, importance_score, tags, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                memory_id,
                self.current_project_id,
                memory_type,
                title,
                content,
                embedding_json,
                content_hash,
                file_path,
                importance,
                json.dumps(tags or []),
                datetime.now().isoformat(),
                datetime.now().isoformat()
            ))

            self.db.connection.commit()
            logging.info(f"Created memory {memory_id} (type={memory_type}, importance={importance:.2f})")
            
            # Create auto-relationships asynchronously
            self._create_auto_relationships(memory_id, content, memory_type)

            # Maintain context window
            self.context_window.append({
                'id': memory_id,
                'type': memory_type,
                'title': title,
                'content': content,
                'importance': importance,
                'file_path': file_path,
                'created_at': datetime.now().isoformat()
            })

            if len(self.context_window) > self.max_context_size:
                self.context_window.pop(0)

            return memory_id
        except Exception as e:
            logging.error(f"Error adding memory: {e}", exc_info=True)
            raise ValidationException(f"Failed to add memory: {e}") from e

    def _create_auto_relationships(self, memory_id: str, content: str, memory_type: str, 
                                   similarity_threshold: Optional[float] = None):
        """
        Automatically create relationships between memories based on semantic similarity.
        
        Only creates relationships if embeddings are available. Uses configurable similarity
        threshold (default: 0.7).
        
        Args:
            memory_id: ID of the new memory
            content: Content of the new memory
            memory_type: Type of the memory
            similarity_threshold: Override default threshold (0.0-1.0). Uses default if None.
        """
        if not self._ensure_embeddings_loaded():
            logging.debug("Embeddings unavailable, skipping auto-relationships")
            return

        threshold = similarity_threshold or self.default_similarity_threshold
        
        if threshold < 0.0 or threshold > 1.0:
            logging.warning(f"Invalid similarity threshold {threshold}, using default {self.default_similarity_threshold}")
            threshold = self.default_similarity_threshold

        try:
            current_embedding = self._generate_embedding(content)
            if not current_embedding:
                logging.debug(f"Failed to generate embedding for memory {memory_id}, skipping relationships")
                return

            cursor = self.db.connection.cursor()
            cursor.execute("""
            SELECT id, embedding_vector, title FROM memories
            WHERE project_id = ? AND id != ? AND embedding_vector IS NOT NULL
            ORDER BY created_at DESC LIMIT 50
            """, (self.current_project_id, memory_id))

            similar_memories = []
            for row in cursor.fetchall():
                other_id, embedding_json, title = row
                if embedding_json:
                    try:
                        other_embedding = json.loads(embedding_json)
                        similarity = self._calculate_similarity(current_embedding, other_embedding)
                        if similarity > threshold:
                            similar_memories.append((other_id, similarity, title))
                            logging.debug(f"Found similar memory: {title} (similarity={similarity:.2f})")
                    except json.JSONDecodeError as e:
                        logging.warning(f"Failed to parse embedding JSON for memory {other_id}: {e}")
                        continue
                    except Exception as e:
                        logging.error(f"Unexpected error comparing embeddings for {other_id}: {e}", exc_info=True)
                        continue

            # Create relationships with top 3 similar memories
            for other_id, similarity, title in similar_memories[:3]:
                rel_id = self.generate_id()
                cursor.execute("""
                INSERT OR IGNORE INTO knowledge_relationships (id, from_type, from_id, to_type, to_id, relationship_type, strength)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (rel_id, 'memory', memory_id, 'memory', other_id, 'similar_content', similarity))
                logging.debug(f"Created relationship between {memory_id} and {other_id} (similarity={similarity:.2f})")

            self.db.connection.commit()
            logging.info(f"Created {len(similar_memories[:3])} auto-relationships for memory {memory_id}")
        except Exception as e:
            logging.error(f"Error creating auto-relationships for memory {memory_id}: {e}", exc_info=True)

    def search_memories_semantic(self, query: str, limit: int = 10, min_similarity: Optional[float] = None) -> List[Dict]:
        """
        Search memories using semantic similarity with text search fallback.
        
        If semantic search is unavailable or returns no results above threshold,
        automatically falls back to full-text search.
        
        Args:
            query: Search query
            limit: Maximum number of results (default: 10)
            min_similarity: Minimum similarity threshold (0.0-1.0). Uses 0.3 if None.
                           Lower thresholds return more results but with lower confidence.
            
        Returns:
            List of matching memory dictionaries with similarity scores (if semantic search used)
        """
        if min_similarity is None:
            min_similarity = 0.3
        elif min_similarity < 0.0 or min_similarity > 1.0:
            logging.warning(f"Invalid similarity threshold {min_similarity}, using 0.3")
            min_similarity = 0.3
            
        if not self.current_project_id:
            logging.warning("No active project, cannot search memories")
            return []

        # Try semantic search first
        if self._ensure_embeddings_loaded():
            try:
                query_embedding = self._generate_embedding(query)
                if not query_embedding:
                    logging.debug("Failed to generate query embedding, falling back to text search")
                    results, _ = self.db.search_memories(query, self.current_project_id, limit=limit)
                    return results

                cursor = self.db.connection.cursor()
                cursor.execute("""
                SELECT id, title, content, type, importance_score, embedding_vector, file_path, created_at
                FROM memories
                WHERE project_id = ? AND embedding_vector IS NOT NULL
                ORDER BY created_at DESC
                """, (self.current_project_id,))

                results = []
                for row in cursor.fetchall():
                    memory_id, title, content, mem_type, importance, embedding_json, file_path, created_at = row
                    try:
                        memory_embedding = json.loads(embedding_json)
                        similarity = self._calculate_similarity(query_embedding, memory_embedding)

                        if similarity >= min_similarity:
                            results.append({
                                'id': memory_id,
                                'title': title,
                                'content': content,
                                'type': mem_type,
                                'importance': importance,
                                'file_path': file_path,
                                'created_at': created_at,
                                'similarity': round(similarity, 3),
                                'search_method': 'semantic'
                            })
                    except json.JSONDecodeError as e:
                        logging.warning(f"Failed to parse embedding for memory {memory_id}: {e}")
                        continue
                    except Exception as e:
                        logging.error(f"Error comparing embeddings for {memory_id}: {e}", exc_info=True)
                        continue

                results.sort(key=lambda x: x['similarity'], reverse=True)
                
                if results:
                    logging.info(f"Semantic search for '{query[:50]}' returned {len(results)} results (min_similarity={min_similarity})")
                    return results[:limit]
                else:
                    logging.debug(f"Semantic search returned no results above threshold {min_similarity}, falling back to text search")
                    
            except Exception as e:
                logging.error(f"Error in semantic search for '{query}': {e}", exc_info=True)
                logging.info("Falling back to text search")

        # Fall back to text search
        logging.debug(f"Using text search for query: {query[:50]}")
        text_results, _ = self.db.search_memories(query, self.current_project_id, limit=limit)
        
        # Add search_method indicator
        for result in text_results:
            result['search_method'] = 'text'
            result['similarity'] = None
            
        return text_results

    def load_relevant_memories(self) -> List[Dict]:
        """
        Load relevant memories for current context with pagination support.
        
        Returns:
            List of relevant memories (max 20)
        """
        if not self.current_project_id:
            return []

        try:
            # Get high-importance memories (first 20)
            memories, _ = self.db.get_memories(
                project_id=self.current_project_id,
                limit=20,
                offset=0,
                sort_by="importance_score"
            )

            # Get recently accessed memories (first 10)
            recent, _ = self.db.get_memories(
                project_id=self.current_project_id,
                limit=10,
                offset=0,
                sort_by="last_accessed"
            )

            # Merge and deduplicate
            all_memories = {m['id']: m for m in memories + recent}
            return list(all_memories.values())
        except Exception as e:
            logging.error(f"Error loading relevant memories: {e}", exc_info=True)
            return []

    def get_memory_context(self, query: str = None) -> str:
        """Get formatted memory context for AI prompt."""
        if not self.current_project_id:
            return "No active project context."

        summary = self.db.get_project_summary(self.current_project_id)

        if query:
            memories = self.db.search_memories(query, self.current_project_id, limit=5)
        else:
            memories = self.load_relevant_memories()[:5]

        context_parts = []

        project_info = summary.get('project', {})
        context_parts.append(f"## Current Project: {project_info.get('name', 'Unknown')}")
        if project_info.get('description'):
            context_parts.append(f"Description: {project_info['description']}")

        memory_counts = summary.get('memory_counts', {})
        if memory_counts:
            context_parts.append(f"\nMemory Summary: {dict(memory_counts)}")

        if memories:
            context_parts.append("\n## Relevant Memories:")
            for memory in memories:
                context_parts.append(f"- [{memory['type']}] {memory['title']}")

        return "\n".join(context_parts)

    # ==================== MEMORY TYPE HELPERS ====================

    def add_working_memory(self, slot: str, value: str, importance: float = 0.9, tags: Optional[List[str]] = None) -> str:
        """Store working memory for the current project/session."""
        content = f"Working Memory [{slot}]: {value}"
        return self.add_context_memory(
            content=content,
            memory_type="working",
            importance=importance,
            tags=tags or ["working", slot]
        )

    def add_semantic_memory(self, content: str, importance: float = 0.8, tags: Optional[List[str]] = None) -> str:
        """Store durable semantic knowledge/facts."""
        return self.add_context_memory(
            content=content,
            memory_type="semantic",
            importance=importance,
            tags=tags or ["semantic"]
        )

    def add_episodic_memory(self, content: str, tags: Optional[List[str]] = None) -> str:
        """Store an episodic memory about something that happened."""
        stamped = f"[{datetime.now().isoformat()}] {content}"
        return self.add_context_memory(
            content=stamped,
            memory_type="episodic",
            importance=0.7,
            tags=tags or ["episodic"]
        )

    def add_procedural_memory(self, content: str, importance: float = 0.8, tags: Optional[List[str]] = None) -> str:
        """Store procedural knowledge (how to do something)."""
        return self.add_context_memory(
            content=content,
            memory_type="procedural",
            importance=importance,
            tags=tags or ["procedural"]
        )
