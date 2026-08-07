import fs from "fs";
import path from "path";
import { pool } from "./pool";

async function migrate() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  try {
    await pool.query(schema);
    console.log("✅ Baza sxemasi muvaffaqiyatli o'rnatildi");
  } catch (err) {
    console.error("❌ Migratsiya xatosi:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
