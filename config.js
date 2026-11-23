// Fill these in from Supabase > Project Settings > API.
// The "anon public" key is meant to be public; the database rules
// (Row Level Security in supabase/schema.sql) are what keep data safe.
// Never put the "service_role" key here.
window.GUILD_CONFIG = {
  SUPABASE_URL: "https://mkuuuorhjvxqjdwpaohe.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rdXV1b3JoanZ4cWpkd3Bhb2hlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzOTIwNTAsImV4cCI6MjExMDk2ODA1MH0.WW85FQYxH3Qi0b9nMB8Vas9zJut-g2V7Q8aScTh4zY4",
  GUILD_NAME: "Foundation Galactic Frontier",
  // Members log in with a name, not an email. Behind the scenes each
  // name is turned into a placeholder email on this domain. No mail is sent.
  LOGIN_EMAIL_DOMAIN: "members.guild-site.app",
};
