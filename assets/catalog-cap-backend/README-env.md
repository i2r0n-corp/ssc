# Environment Variables — catalog-cap-backend

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4004` | HTTP port the server listens on |
| `CAP_PUBLISH_TOKEN` | Yes (production) | _(none — dev allows all)_ | Static bearer token that must be provided in the `Authorization` header when calling `POST /api/catalog/publishSnapshot` or `PUT /api/catalog/excel/:bsCode`. Set to a strong random string. |
| `EXCEL_STORE_PATH` | No | `./data/excels` | File system path where uploaded Excel BS mapping files are stored. Use a persistent volume mount in production. |

## Notes

- In development, if `CAP_PUBLISH_TOKEN` is not set, all publish and Excel upload calls are allowed without authentication.
- The `data/` folder is created automatically at startup.
- PPTX files are generated into `data/pptx-tmp/` and served on demand. They are not cleaned up automatically — add a cron job or restart-based cleanup if storage is a concern.
