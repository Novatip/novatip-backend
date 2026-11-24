# Prisma Migrations

Each migration directory must use a unique 14-digit timestamp prefix (`<YYYYMMDDHHMMSS>_<description>`). CI enforces this via `npm run check:migration-timestamps`.

## Renaming Already-Shipped Migration Directories

Prisma records applied migrations by directory name in the `"_prisma_migrations"` table. If you are upgrading an environment where the pre-rename migration names were already applied, update `"_prisma_migrations"` before running `prisma migrate deploy` so Prisma does not treat the renamed directories as unapplied migrations:

```sql
UPDATE "_prisma_migrations"
SET "migration_name" = CASE "migration_name"
  WHEN '20261019000000_creator_account_deletion' THEN '20261019000002_creator_account_deletion'
  WHEN '20261021000000_drop_tip_unused_indexes' THEN '20261021000001_drop_tip_unused_indexes'
  WHEN '20261021000000_message_hidden' THEN '20261021000002_message_hidden'
  WHEN '20261021000001_notification_read_at' THEN '20261021000003_notification_read_at'
  ELSE "migration_name"
END
WHERE "migration_name" IN (
  '20261019000000_creator_account_deletion',
  '20261021000000_drop_tip_unused_indexes',
  '20261021000000_message_hidden',
  '20261021000001_notification_read_at'
);
```

Because none of the SQL files or checksums were modified and the colliding migrations are independent of one another, updating `"migration_name"` in place preserves migration history without re-running DDL.
