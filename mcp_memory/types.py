"""
Type definitions and response models for MCP Memory Server.
"""

from typing import Dict, List, Any, Optional, Union
from dataclasses import dataclass, asdict
import json


@dataclass
class MemoryRecord:
    """Represents a memory in the system."""
    id: str
    project_id: str
    type: str
    title: str
    content: str
    importance: float
    created_at: str
    similarity: Optional[float] = None
    file_path: Optional[str] = None
    tags: Optional[List[str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary, handling None values."""
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class SuccessResponse:
    """Standard success response format."""
    status: str = "success"
    data: Optional[Dict[str, Any]] = None
    message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "status": self.status,
            **({"data": self.data} if self.data else {}),
            **({"message": self.message} if self.message else {})
        }


@dataclass
class ErrorResponse:
    """Standard error response format."""
    status: str = "error"
    error: str = "Unknown error"
    code: Optional[str] = None
    details: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = {
            "status": self.status,
            "error": self.error,
        }
        if self.code:
            result["code"] = self.code
        if self.details:
            result["details"] = self.details
        return result


@dataclass
class SearchResult:
    """Represents search results."""
    total: int
    limit: int
    offset: int
    results: List[MemoryRecord]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "total": self.total,
            "limit": self.limit,
            "offset": self.offset,
            "results": [r.to_dict() for r in self.results]
        }


@dataclass
class ProjectContext:
    """Represents project context information."""
    project_id: str
    project_name: str
    project_path: str
    session_id: str
    memory_counts: Dict[str, int]
    recent_memories: List[MemoryRecord]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "project_id": self.project_id,
            "project_name": self.project_name,
            "project_path": self.project_path,
            "session_id": self.session_id,
            "memory_counts": self.memory_counts,
            "recent_memories": [m.to_dict() for m in self.recent_memories]
        }


@dataclass
class ConventionsInfo:
    """Represents project conventions."""
    project_type: str
    environment: Dict[str, Any]
    commands: Dict[str, List[str]]
    tools: Dict[str, Any]
    dependencies: Dict[str, Any]
    deployment: Dict[str, Any]
    testing: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "project_type": self.project_type,
            "environment": self.environment,
            "commands": self.commands,
            "tools": self.tools,
            "dependencies": self.dependencies,
            "deployment": self.deployment,
            "testing": self.testing
        }


@dataclass
class DatabaseStats:
    """Represents database statistics."""
    projects_count: int
    memories_count: int
    relationships_count: int
    sessions_count: int
    database_size_mb: float
    avg_memory_importance: float
    max_memory_accessed: int
    memory_types_count: int

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)
