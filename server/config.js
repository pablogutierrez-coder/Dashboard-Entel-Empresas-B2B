import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 5173),
  firebaseUrl: String(process.env.FIREBASE_URL || "").replace(/\/?$/, "/"),
  firebaseSecret: String(process.env.FIREBASE_DATABASE_SECRET || ""),
  spreadsheetId: String(process.env.SPREADSHEET_ID || ""),
  driveRootFolderId: String(process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || ""),
  googleCredentials: String(process.env.GOOGLE_APPLICATION_CREDENTIALS || ""),
  googleCredentialsJson: String(process.env.GOOGLE_CREDENTIALS_JSON || ""),
  firebaseStorageBucket: String(process.env.FIREBASE_STORAGE_BUCKET || ""),
  openaiApiKey: String(process.env.OPENAI_API_KEY || ""),
  openaiModel: String(process.env.OPENAI_MODEL || "gpt-4.1-mini")
};

export function requireConfig(name, value) {
  if (!value) {
    throw new Error(`Falta configurar ${name} en .env`);
  }
}
