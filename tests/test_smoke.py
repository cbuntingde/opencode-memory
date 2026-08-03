#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Comprehensive tests for MCP Memory Server improvements."""
import sys
import os
import tempfile
import json
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp_memory.database import DatabaseManager
from mcp_memory.memory import MemoryManager
from mcp_memory.conventions import ProjectConventionLearner
from mcp_memory.validation import validate_content, validate_memory_type, validate_tags
from mcp_memory.exceptions import ValidationException
from mcp_memory.metrics import get_metrics_collector


def test_database_with_pagination():
    """Test database pagination support."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        db = DatabaseManager(db_path)
        
        project_id = db.get_or_create_project("test", "/tmp/test", "Test project")
        
        # Add 25 memories
        for i in range(25):
            db.add_memory(project_id, "semantic", f"Mem{i}", f"Content {i}", importance_score=0.5 + i*0.01)
        
        # Test pagination
        page1, total = db.get_memories(project_id=project_id, limit=10, offset=0)
        assert len(page1) == 10, f"Expected 10, got {len(page1)}"
        assert total == 25, f"Expected total 25, got {total}"
        
        page2, total = db.get_memories(project_id=project_id, limit=10, offset=10)
        assert len(page2) == 10
        assert total == 25
        
        page3, total = db.get_memories(project_id=project_id, limit=10, offset=20)
        assert len(page3) == 5
        assert total == 25
        
        db.close()
        print("[OK] Pagination support works")


def test_search_with_pagination():
    """Test search results pagination."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        db = DatabaseManager(db_path)
        
        pid = db.get_or_create_project("search", "/tmp/search", "Search test")
        
        # Add memories with searchable content
        for i in range(15):
            db.add_memory(pid, "semantic", f"Python tip {i}", f"Python is great for {i}")
        
        # Search with pagination
        results, total = db.search_memories("Python", project_id=pid, limit=5, offset=0)
        assert len(results) <= 5
        assert total >= 5
        
        db.close()
        print("[OK] Search pagination works")


def test_input_validation():
    """Test input validation prevents invalid data."""
    # Test content validation
    try:
        validate_content("")
        assert False, "Should reject empty content"
    except ValidationException:
        pass
    
    valid = validate_content("Valid content")
    assert valid == "Valid content"
    
    # Test memory type validation
    try:
        validate_memory_type("invalid_type")
        assert False, "Should reject invalid type"
    except ValidationException:
        pass
    
    valid_type = validate_memory_type("semantic")
    assert valid_type == "semantic"
    
    # Test tags validation
    tags = validate_tags(["tag1", "tag1"])  # Duplicates
    assert len(tags) == 1
    
    print("[OK] Input validation works")


def test_memory_classification():
    """Test automatic memory classification."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        db = DatabaseManager(db_path)
        mem = MemoryManager(db)
        
        mem.start_session("/tmp/test")
        
        # Test classification
        error_type, importance = mem.classify_memory("interaction", "Error: connection failed")
        assert error_type == "error"
        assert importance >= 0.7
        
        decision_type, importance = mem.classify_memory("interaction", "We decided to use PostgreSQL")
        assert decision_type == "decision"
        assert importance >= 0.8
        
        db.close()
        print("[OK] Memory classification works")


def test_metrics_collection():
    """Test metrics collection."""
    metrics = get_metrics_collector()
    
    # Record operations
    metrics.record_operation("test_op", 100.0, True)
    metrics.record_operation("test_op", 50.0, False)
    
    op_metrics = metrics.get_operation_metrics("test_op")
    assert op_metrics["total_calls"] == 2
    assert op_metrics["successful_calls"] == 1
    assert op_metrics["failed_calls"] == 1
    assert op_metrics["success_rate"] == 0.5
    
    print("[OK] Metrics collection works")


def test_disabled_embeddings():
    """Test embeddings can be disabled for performance."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        db = DatabaseManager(db_path)
        
        # Create manager with embeddings disabled
        mem = MemoryManager(db, disable_embeddings=True)
        assert mem.disable_embeddings
        
        mem.start_session("/tmp/test")
        
        # Adding memory should still work
        memory_id = mem.add_context_memory("Test content")
        assert memory_id
        
        db.close()
        print("[OK] Disabled embeddings mode works")


def test_conventions_learning():
    """Test project conventions learning."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        db = DatabaseManager(db_path)
        mem = MemoryManager(db)
        conv = ProjectConventionLearner(mem, db)
        
        mem.start_session(tmpdir)
        
        # Learn conventions
        conventions = conv.auto_learn_project_conventions(tmpdir)
        assert "environment" in conventions
        assert conventions["environment"]["os"]
        
        db.close()
        print("[OK] Conventions learning works")


if __name__ == "__main__":
    test_database_with_pagination()
    test_search_with_pagination()
    test_input_validation()
    test_memory_classification()
    test_metrics_collection()
    test_disabled_embeddings()
    test_conventions_learning()
    print("\n[SUCCESS] All comprehensive tests passed!")
