---
slug: framework/django
title: Django
loadWhen:
  - kind: workspace.has
    path: manage.py
  - kind: workspace.hasGlob
    glob: "**/settings.py"
  - kind: hint.framework
    value: django
sizeTarget: 700
priority: 4
---
# Django
## When this applies
Use this for Django projects detected through `manage.py`, a `settings.py`, or a Django framework hint.

## Core rules
- Read `SECRET_KEY`, database credentials, and API keys from the environment (`os.environ` / `django-environ`); never hardcode them in `settings.py`.
- Split or environment-drive settings (base + dev/prod). `DEBUG = False` and a real `ALLOWED_HOSTS` in production.
- Use the ORM. Avoid raw SQL unless measured; guard against N+1 with `select_related` (FK/one-to-one) and `prefetch_related` (many).
- Every model change ships with a migration: run `makemigrations`, commit the generated file, and `migrate`. Never edit an already-applied migration.
- Fat models / thin views: put business logic in models, managers, or a `services.py`, not in views or templates.
- Build APIs with Django REST Framework — validate and shape data in serializers, not views. Use `ViewSet`/generic views to cut boilerplate.
- Use `django.contrib.auth` for authentication and password hashing; never roll your own.
- Validate all request data through Forms or DRF serializers before use; never trust `request.POST`/`request.data` directly.
- Keep `USE_TZ = True` and use `django.utils.timezone.now()`; never `datetime.now()` for stored timestamps.

## Common pitfalls
- N-PLUS-ONE: iterating a queryset that touches related objects without `select_related`/`prefetch_related`.
- MIGRATION-DRIFT: model fields changed but no migration generated (schema and code diverge).
- SECRET-IN-SETTINGS: `SECRET_KEY` or DB credentials committed in `settings.py`.
- QUERY-IN-LOOP: issuing ORM queries inside a Python loop instead of one bulk query.
- SIGNAL-SPRAWL: hiding required side effects in `post_save`/`pre_save` signals instead of explicit service calls.

## House style
Reference projects use a settings module (env-driven), apps grouped under the project package, DRF serializers/viewsets for APIs, `django-environ` for configuration, and `pytest-django` (or `manage.py test`) for tests.

## Verification commands
- `python manage.py check`
- `python manage.py makemigrations --check --dry-run`
- `python manage.py migrate --plan`
- `python manage.py test` (or `pytest`)
- `rg -n "datetime\\.now\\(\\)|\\.objects\\.(all|filter)\\(.*\\)\\s*$" --glob '*.py'`

## Canonical sources
- manage.py
- <project>/settings.py
- <project>/urls.py
- <app>/models.py
- <app>/serializers.py
