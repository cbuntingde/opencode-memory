"""
Standard API response formatting for MCP Memory Server.

Ensures all tool responses follow a consistent format with status, data, and metadata.
"""

from typing import Any, Dict, Optional, List
from dataclasses import dataclass, asdict
from datetime import datetime
import logging


@dataclass
class ApiResponse:
    """Standard API response envelope."""
    status: str  # "success", "error", "partial"
    data: Optional[Any] = None
    error: Optional[str] = None
    code: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    timestamp: Optional[str] = None

    def __post_init__(self):
        """Set timestamp if not provided."""
        if self.timestamp is None:
            self.timestamp = datetime.now().isoformat()

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary, excluding None values."""
        result = {
            "status": self.status,
            "timestamp": self.timestamp,
        }
        
        if self.data is not None:
            result["data"] = self.data
        if self.error is not None:
            result["error"] = self.error
        if self.code is not None:
            result["code"] = self.code
        if self.metadata is not None:
            result["metadata"] = self.metadata
            
        return result


def success_response(data: Any, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Create a success response.
    
    Args:
        data: Response data
        metadata: Optional metadata (e.g., pagination info)
        
    Returns:
        Standardized response dictionary
    """
    response = ApiResponse(
        status="success",
        data=data,
        metadata=metadata
    )
    return response.to_dict()


def error_response(error_msg: str, code: str = "ERROR", metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Create an error response.
    
    Args:
        error_msg: Error message
        code: Error code (e.g., "NOT_FOUND", "INVALID_INPUT")
        metadata: Optional metadata
        
    Returns:
        Standardized error response dictionary
    """
    response = ApiResponse(
        status="error",
        error=error_msg,
        code=code,
        metadata=metadata
    )
    return response.to_dict()


def partial_response(data: Any, error_msg: str, code: str = "PARTIAL", 
                    metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Create a partial success response (some operations succeeded, some failed).
    
    Args:
        data: Partial data
        error_msg: Error message for failures
        code: Error code
        metadata: Optional metadata
        
    Returns:
        Standardized partial response dictionary
    """
    response = ApiResponse(
        status="partial",
        data=data,
        error=error_msg,
        code=code,
        metadata=metadata
    )
    return response.to_dict()


def paginated_response(results: List[Any], total: int, limit: int, offset: int) -> Dict[str, Any]:
    """
    Create a paginated response.
    
    Args:
        results: Page results
        total: Total count
        limit: Page size
        offset: Pagination offset
        
    Returns:
        Response with pagination metadata
    """
    returned = len(results)
    has_more = (offset + returned) < total
    
    metadata = {
        "pagination": {
            "total": total,
            "limit": limit,
            "offset": offset,
            "returned": returned,
            "has_more": has_more,
            "pages": (total + limit - 1) // limit if limit > 0 else 0,
            "current_page": (offset // limit) + 1 if limit > 0 else 1,
        }
    }
    
    return success_response(results, metadata=metadata)


def search_response(results: List[Any], total: int, query: str, search_method: str = "text",
                   limit: int = 10, offset: int = 0) -> Dict[str, Any]:
    """
    Create a search response with metadata.
    
    Args:
        results: Search results
        total: Total matches
        query: Search query
        search_method: "text" or "semantic"
        limit: Results per page
        offset: Pagination offset
        
    Returns:
        Response with search metadata
    """
    returned = len(results)
    has_more = (offset + returned) < total
    
    metadata = {
        "search": {
            "query": query,
            "method": search_method,
            "total_matches": total,
        },
        "pagination": {
            "total": total,
            "limit": limit,
            "offset": offset,
            "returned": returned,
            "has_more": has_more,
        }
    }
    
    return success_response(results, metadata=metadata)


def health_response(database_ok: bool, embeddings_available: bool, 
                   embeddings_loaded: bool, **extra_info) -> Dict[str, Any]:
    """
    Create a health check response.
    
    Args:
        database_ok: Database connectivity status
        embeddings_available: Embeddings available
        embeddings_loaded: Embeddings loaded
        **extra_info: Additional health info
        
    Returns:
        Health status response
    """
    is_healthy = database_ok and embeddings_available
    
    health_data = {
        "database": {
            "connected": database_ok,
        },
        "embeddings": {
            "available": embeddings_available,
            "loaded": embeddings_loaded,
        },
        **extra_info
    }
    
    status_str = "healthy" if is_healthy else ("degraded" if database_ok else "unhealthy")
    
    response = ApiResponse(
        status="success" if is_healthy else "error",
        data=health_data,
        code=status_str,
    )
    
    return response.to_dict()
