// app.json holds the config; this only stamps the versionCode that build.sh computes for each build.
module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, versionCode: Number(process.env.AI_DERS_VERSION_CODE) || 1 },
});
