.PHONY: help dev prod build push test lint clean

IMAGE ?= your-registry/cordon-gateway
TAG   ?= 0.1.0

help:
	@echo "Cordon MCP Security Gateway"
	@echo ""
	@echo "  make dev        Start dev stack (Cordon + OPA + mock server)"
	@echo "  make prod       Start production stack (Cordon + OPA + Postgres)"
	@echo "  make build      Build Docker image"
	@echo "  make push       Push image to registry"
	@echo "  make test       Run test suite"
	@echo "  make lint       Check code style"
	@echo "  make clean      Remove containers and volumes"

# ---------- local dev ----------

dev:
	docker compose up --build

dev-down:
	docker compose down

# ---------- production ----------

prod:
	docker compose -f docker-compose.prod.yml up -d

prod-down:
	docker compose -f docker-compose.prod.yml down

prod-logs:
	docker compose -f docker-compose.prod.yml logs -f cordon-gateway

# ---------- image ----------

build:
	docker build -t $(IMAGE):$(TAG) .

push: build
	docker push $(IMAGE):$(TAG)

# ---------- testing ----------

test:
	python -m pytest tests/ -v

test-fast:
	python -m pytest tests/ -q

# ---------- linting ----------

lint:
	python -m py_compile main.py db.py dashboard.py auth.py pii.py \
	  ratelimit.py alerting.py cordon_sdk.py
	@echo "Syntax OK"

# ---------- helm ----------

helm-lint:
	helm lint helm/cordon

helm-template:
	helm template cordon helm/cordon

helm-install:
	helm install cordon helm/cordon \
	  --set gateway.realMcpServer=http://your-mcp-server:8001 \
	  --set auth.dashboardKey=changeme \
	  --set auth.sessionSecret=changeme

helm-upgrade:
	helm upgrade cordon helm/cordon -f helm-values.yaml

helm-uninstall:
	helm uninstall cordon

# ---------- cleanup ----------

clean:
	docker compose down -v
	docker compose -f docker-compose.prod.yml down -v
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true
	rm -f cordon_audit.db
