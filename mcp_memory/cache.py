"""
Caching utilities for MCP Memory Server to improve performance.
"""

import time
import logging
from typing import Any, Optional, Callable, Dict
from functools import wraps
from datetime import datetime, timedelta


class CacheEntry:
    """A single cache entry with TTL support."""
    
    def __init__(self, value: Any, ttl_seconds: Optional[int] = None):
        """
        Initialize cache entry.
        
        Args:
            value: Value to cache
            ttl_seconds: Time-to-live in seconds. None = no expiry.
        """
        self.value = value
        self.created_at = datetime.now()
        self.ttl_seconds = ttl_seconds
    
    def is_expired(self) -> bool:
        """Check if entry has expired."""
        if self.ttl_seconds is None:
            return False
        age = (datetime.now() - self.created_at).total_seconds()
        return age > self.ttl_seconds


class SimpleCache:
    """Simple in-memory cache with TTL support."""
    
    def __init__(self, max_size: int = 1000):
        """
        Initialize cache.
        
        Args:
            max_size: Maximum number of entries (LRU eviction after this)
        """
        self.cache: Dict[str, CacheEntry] = {}
        self.max_size = max_size
        self.hits = 0
        self.misses = 0
        self.logger = logging.getLogger(__name__)
    
    def get(self, key: str) -> Optional[Any]:
        """
        Get value from cache.
        
        Args:
            key: Cache key
            
        Returns:
            Cached value or None if not found or expired
        """
        if key not in self.cache:
            self.misses += 1
            return None
        
        entry = self.cache[key]
        if entry.is_expired():
            del self.cache[key]
            self.misses += 1
            return None
        
        self.hits += 1
        return entry.value
    
    def set(self, key: str, value: Any, ttl_seconds: Optional[int] = None):
        """
        Set value in cache.
        
        Args:
            key: Cache key
            value: Value to cache
            ttl_seconds: Time-to-live in seconds
        """
        # Simple LRU: remove oldest if at capacity
        if len(self.cache) >= self.max_size:
            oldest_key = min(
                self.cache.keys(),
                key=lambda k: self.cache[k].created_at
            )
            del self.cache[oldest_key]
            logging.debug(f"Evicted cache entry: {oldest_key}")
        
        self.cache[key] = CacheEntry(value, ttl_seconds)
    
    def clear(self):
        """Clear all cache entries."""
        self.cache.clear()
        logging.debug("Cache cleared")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        total = self.hits + self.misses
        hit_rate = (self.hits / total * 100) if total > 0 else 0.0
        
        return {
            "size": len(self.cache),
            "max_size": self.max_size,
            "hits": self.hits,
            "misses": self.misses,
            "total_requests": total,
            "hit_rate": round(hit_rate, 2),
        }


def cached(ttl_seconds: Optional[int] = 300, key_func: Optional[Callable] = None):
    """
    Decorator for caching function results.
    
    Args:
        ttl_seconds: Cache TTL in seconds (default: 5 minutes)
        key_func: Function to generate cache key from arguments
        
    Usage:
        @cached(ttl_seconds=60)
        def expensive_operation(x):
            return x ** 2
        
        # With custom key
        @cached(key_func=lambda args, kwargs: f"{args[0]}")
        def get_by_id(id):
            return db.fetch(id)
    """
    _cache = SimpleCache()
    
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            # Generate cache key
            if key_func:
                cache_key = key_func(args, kwargs)
            else:
                # Default: use function name and args
                cache_key = f"{func.__name__}:{str(args)}:{str(kwargs)}"
            
            # Try cache
            cached_value = _cache.get(cache_key)
            if cached_value is not None:
                logging.debug(f"Cache hit for {func.__name__}")
                return cached_value
            
            # Call function and cache result
            result = func(*args, **kwargs)
            _cache.set(cache_key, result, ttl_seconds)
            logging.debug(f"Cache miss for {func.__name__}, cached for {ttl_seconds}s")
            
            return result
        
        # Add stats method
        wrapper.cache_stats = lambda: _cache.get_stats()
        wrapper.cache_clear = lambda: _cache.clear()
        
        return wrapper
    
    return decorator


# Global cache instances
_project_summary_cache = SimpleCache(max_size=100)


def cache_project_summary(func):
    """Decorator for caching project summaries (5 minute TTL)."""
    return cached(ttl_seconds=300, key_func=lambda args, kwargs: f"summary:{args[1]}")(func)


def invalidate_project_cache(project_id: str):
    """Invalidate all caches for a project."""
    _project_summary_cache.clear()
    logging.debug(f"Invalidated cache for project {project_id}")
