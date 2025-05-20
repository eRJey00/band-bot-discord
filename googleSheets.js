const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: SCOPES,
});

const sheets = google.sheets({ version: "v4", auth });

module.exports = {
  sheets,
};
