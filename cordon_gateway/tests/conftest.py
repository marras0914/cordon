import os
import sys
import sqlite3

import pytest

# Ensure cordon_gateway/ is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(scope="session")
def test_db_path(tmp_path_factory):
    """One temp DB file for the whole test session."""
    return str(tmp_path_factory.mktemp("data") / "test_cordon.db")


@pytest.fixture(scope="session", autouse=True)
def configure_db(test_db_path):
    """Patch db.DB_PATH before the app is imported."""
    import db
    db.DB_PATH = test_db_path
    db.init_db()


@pytest.fixture(autouse=True)
def clean_tables(test_db_path):
    """Wipe all rows between tests."""
    yield
    con = sqlite3.connect(test_db_path)
    con.execute("DELETE FROM audit_log")
    con.execute("DELETE FROM approval_queue")
    con.commit()
    con.close()


@pytest.fixture(scope="session")
def client(configure_db):
    from starlette.testclient import TestClient
    import main
    with TestClient(main.app) as c:
        yield c
