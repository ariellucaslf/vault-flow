# Global Agent Directives & Engineering Standards

This document defines the architectural guidelines, development workflows, security policies, and technical standards for AI agents and developers working on this project.

---

## 1. Core Architecture & Tech Stack

- **Architecture Pattern**: Model-View-Controller (MVC)
  - **Model**: Prisma schemas, database entities, and repository/data access services.
  - **View**: Next.js (App Router) pages, layouts, and client/server UI components.
  - **Controller**: Dedicated domain controllers handling request validation, orchestrating business logic, and returning standardized responses.
- **Backend**: Node.js with strict TypeScript (`tsconfig.json` with strict mode enabled).
- **Frontend**: Next.js (App Router) with TypeScript.
- **ORM & Database**: Prisma ORM paired with PostgreSQL.

---

## 2. File Organization, Controllers & Routing Patterns

- **Modular Domain Controllers**:
  - Logic must be explicitly organized into dedicated controller files named according to their feature responsibility (e.g., `auth.controller.ts`, `user.controller.ts`, `order.controller.ts`).
  - Controllers contain request handling logic for their specific domain, delegating data access to service/repository layers.
- **Feature Route Files**:
  - Route definitions must mirror the controller domain naming convention (e.g., `auth.routes.ts`, `user.routes.ts`, `order.routes.ts`).
- **Centralized Route Aggregation**:
  - All individual feature route files must be imported and registered inside a main routing entry point (e.g., `routes/index.ts` or `src/routes/index.ts`).
  - Direct, scattered route registration in the main application file is prohibited; all routes must pass through the central `index` router.

---

## 3. Pragmatic Development Mindset & Bug Prevention

- **Step-by-Step Execution**:
  - Work incrementally. Break complex features into small, verifiable steps.
  - Verify every stage before advancing to the next. Avoid speculative over-engineering.
- **Defensive Programming**:
  - Validate all inputs at application boundaries (API endpoints, Server Actions, forms) using schema validators (e.g., Zod).
  - Explicitly handle null, undefined, edge cases, and asynchronous rejections.
  - Never catch errors silently (`try { ... } catch {}`). Always log and return structured error context.
- **Clean Code Standards**:
  - Follow SOLID, DRY, and KISS principles.
  - Keep Controllers/Handlers lean; isolate domain/business logic in dedicated service modules.
  - Maintain strict TypeScript type coverage. **Do not use `any`**; use `unknown` with proper type narrowing when handling dynamic payloads.

---

## 4. Database Management & Migrations

- **Migration Workflow**:
  - Always execute database schema updates using named migration commands to preserve history and enable auditability:
    ```bash
    npx prisma migrate dev --name <descriptive_migration_name>
    ```
  - Never apply raw schema alterations manually in production without a corresponding Prisma migration file.
- **Query Optimization**:
  - Design tables with explicit column types, primary keys, foreign keys, and indexes on lookup columns.
  - Avoid N+1 database queries by using explicit `select` / `include` parameters in Prisma queries.

---

## 5. Security & Access Control

- **Authentication & Authorization (RBAC)**:
  - Protect all private endpoints and Next.js routes with explicit authentication checks.
  - Enforce permission checks (role-based access control) at the service layer, not just on the UI.
- **Data Protection & Sanitization**:
  - Never store plain-text credentials or sensitive tokens. Hash passwords using industry standards (e.g., Argon2 / bcrypt).
  - Sanitize inputs to protect against SQL Injection, XSS, and CSRF attacks.
- **Secrets & Environment Variables**:
  - Never hardcode secrets, API keys, or database URLs in source code.
  - Validate environment variables at application startup (e.g., via Zod schema).
  - Ensure `.env*` files containing secrets are strictly included in `.gitignore`.

---

## 6. Dependency Management & Supply-Chain Protection

- **Safe Package Installation**:
  - Always prefer **LTS (Long Term Support)** versions or packages that have been published for **at least 24 hours** to mitigate zero-day supply-chain attacks and malicious npm package publications.
  - Inspect dependencies for active maintenance, security advisory history, and low vulnerability footprints.
  - Commit lockfiles (`package-lock.json` or `pnpm-lock.yaml`) to ensure deterministic build environments.

---

## 7. API Design & Response Formatting

- **Consistent JSON Structure**:
  - All API routes must return a consistent payload envelope:
    ```json
    {
      "success": true,
      "data": { ... },
      "error": null
    }
    ```
  - Return precise HTTP status codes (e.g., `200 OK`, `201 Created`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `500 Internal Server Error`).
- **Error Protection**:
  - In production, do not leak raw stack traces or internal database errors to clients. Return sanitized user-friendly error messages.

---

## 8. Verification & Code Quality

- **Automated Validation**:
  - Before completing any task, verify that code passes type-checking (`npx tsc --noEmit`) and linting without errors.
- **Atomic Changes**:
  - Keep commits and pull requests small, focused, and well-documented.