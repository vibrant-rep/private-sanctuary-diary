const CONFIG = {
  folderName: 'MyPrivateSanctuary_Sync',
  diaryFileName: 'diary_data.json',
  timezone: 'Asia/Tokyo',
  latitude: 35.6896,
  longitude: 139.7006,
  locationName: '東京・新宿',
  attribution: 'Weather data by Open-Meteo.com',
  weatherEndpoint: 'https://api.open-meteo.com/v1/jma',
  weatherApiEndpoint: 'https://api.weatherapi.com/v1/forecast.json',
  retryFunctionName: 'retryDailyWeatherOutfit',
  retryDelayMinutes: 60,
  maxWeatherRetriesPerDay: 3,
};

const PERIODS = [
  { key: 'morning', label: '朝', startHour: 6, endHour: 9 },
  { key: 'daytime', label: '昼', startHour: 11, endHour: 15 },
  { key: 'evening', label: '晩', startHour: 18, endHour: 22 },
];

function postDailyWeatherOutfit() {
  runWeatherPost_({ allowRetry: true });
}

function retryDailyWeatherOutfit() {
  clearWeatherRetryTriggers_();
  runWeatherPost_({ allowRetry: true });
}

function runWeatherPost_(options = {}) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const now = new Date();
    const todayKey = formatDateKey_(now);
    const weather = fetchWeatherForecast_();
    const days = buildDailyWeatherOutfits_(weather, now);
    const content = buildPostContent_(days, now, weather);
    upsertDiaryMessage_(todayKey, buildWeatherMessage_(todayKey, content, now));
    clearWeatherRetryState_(todayKey);
  } catch (err) {
    if (options.allowRetry && isRetryableWeatherError_(err)) {
      scheduleWeatherRetry_(formatDateKey_(new Date()), err);
    }
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function runWeatherOutfitOnceForTest() {
  runWeatherPost_({ allowRetry: false });
}

function installMorningWeatherTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => ['postDailyWeatherOutfit', CONFIG.retryFunctionName].includes(trigger.getHandlerFunction()))
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('postDailyWeatherOutfit')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .inTimezone(CONFIG.timezone)
    .create();
}

function isRetryableWeatherError_(err) {
  const message = String(err && err.message ? err.message : err);
  return /Open-Meteo|WeatherAPI|429|limit|Too Many Requests|request failed/i.test(message);
}

function scheduleWeatherRetry_(dateKey, err) {
  const props = PropertiesService.getScriptProperties();
  const key = `WEATHER_RETRY_COUNT_${dateKey}`;
  const retryCount = Number(props.getProperty(key) || 0);
  if (retryCount >= CONFIG.maxWeatherRetriesPerDay) {
    console.error(`Weather retry limit reached for ${dateKey}: ${err && err.message ? err.message : err}`);
    return;
  }

  props.setProperty(key, String(retryCount + 1));
  clearWeatherRetryTriggers_();
  ScriptApp.newTrigger(CONFIG.retryFunctionName)
    .timeBased()
    .after(CONFIG.retryDelayMinutes * 60 * 1000)
    .create();
  console.warn(`Scheduled weather retry ${retryCount + 1}/${CONFIG.maxWeatherRetriesPerDay} for ${dateKey}`);
}

function clearWeatherRetryTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === CONFIG.retryFunctionName)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function clearWeatherRetryState_(dateKey) {
  PropertiesService.getScriptProperties().deleteProperty(`WEATHER_RETRY_COUNT_${dateKey}`);
  clearWeatherRetryTriggers_();
}

function fetchWeatherForecast_() {
  const weatherApiKey = PropertiesService.getScriptProperties().getProperty('WEATHERAPI_KEY');
  if (weatherApiKey) {
    try {
      return fetchWeatherApiForecast_(weatherApiKey);
    } catch (err) {
      console.warn(`WeatherAPI failed, falling back to Open-Meteo: ${err && err.message ? err.message : err}`);
    }
  }

  return fetchOpenMeteoForecast_();
}

function fetchWeatherApiForecast_(apiKey) {
  const params = {
    key: apiKey,
    q: `${CONFIG.latitude},${CONFIG.longitude}`,
    days: 2,
    aqi: 'no',
    alerts: 'no',
    lang: 'ja',
  };
  const url = `${CONFIG.weatherApiEndpoint}?${toQueryString_(params)}`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() >= 400) {
    throw new Error(`WeatherAPI request failed: ${response.getResponseCode()} ${response.getContentText()}`);
  }

  return normalizeWeatherApiForecast_(JSON.parse(response.getContentText()));
}

function normalizeWeatherApiForecast_(data) {
  const hourly = {
    time: [],
    temperature_2m: [],
    apparent_temperature: [],
    relative_humidity_2m: [],
    precipitation: [],
    precipitation_probability: [],
    weather_code: [],
    wind_speed_10m: [],
    wind_gusts_10m: [],
  };

  ((data.forecast || {}).forecastday || []).forEach(day => {
    (day.hour || []).forEach(hour => {
      hourly.time.push(String(hour.time || '').replace(' ', 'T'));
      hourly.temperature_2m.push(readWeatherApiNumber_(hour.temp_c));
      hourly.apparent_temperature.push(readWeatherApiNumber_(hour.feelslike_c));
      hourly.relative_humidity_2m.push(readWeatherApiNumber_(hour.humidity));
      hourly.precipitation.push(readWeatherApiNumber_(hour.precip_mm));
      hourly.precipitation_probability.push(readWeatherApiNumber_(hour.chance_of_rain));
      hourly.weather_code.push(mapWeatherApiConditionCode_(hour.condition && hour.condition.code));
      hourly.wind_speed_10m.push(readWeatherApiNumber_(hour.wind_kph));
      hourly.wind_gusts_10m.push(readWeatherApiNumber_(hour.gust_kph));
    });
  });

  return { hourly, attribution: 'Weather data by WeatherAPI.com' };
}

function readWeatherApiNumber_(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapWeatherApiConditionCode_(code) {
  const value = Number(code);
  if ([1000].includes(value)) return 1;
  if ([1003].includes(value)) return 2;
  if ([1006, 1009].includes(value)) return 3;
  if ([1030, 1135, 1147].includes(value)) return 45;
  if ([1150, 1153, 1168].includes(value)) return 51;
  if ([1171].includes(value)) return 55;
  if ([1063, 1180, 1183, 1186, 1189, 1240].includes(value)) return 61;
  if ([1192, 1195, 1243, 1246].includes(value)) return 63;
  if ([1198, 1201].includes(value)) return 65;
  if ([1066, 1069, 1072, 1114, 1204, 1207, 1210, 1213, 1249, 1255].includes(value)) return 71;
  if ([1117, 1216, 1219, 1222, 1252, 1258].includes(value)) return 73;
  if ([1225, 1237, 1261, 1264].includes(value)) return 75;
  if ([1087, 1273, 1276, 1279, 1282].includes(value)) return 95;
  return 3;
}

function fetchOpenMeteoForecast_() {
  const hourly = [
    'temperature_2m',
    'apparent_temperature',
    'relative_humidity_2m',
    'precipitation',
    'precipitation_probability',
    'weather_code',
    'wind_speed_10m',
    'wind_gusts_10m',
  ];

  const params = {
    latitude: CONFIG.latitude,
    longitude: CONFIG.longitude,
    hourly: hourly.join(','),
    timezone: CONFIG.timezone,
    forecast_days: 2,
  };

  const fallbackHourly = hourly.filter(name => name !== 'precipitation_probability' && name !== 'wind_gusts_10m');
  const attempts = [
    `${CONFIG.weatherEndpoint}?${toQueryString_(params)}`,
    `${CONFIG.weatherEndpoint}?${toQueryString_({ ...params, hourly: fallbackHourly.join(',') })}`,
    `https://api.open-meteo.com/v1/forecast?${toQueryString_(params)}`,
  ];

  let lastError = '';
  for (const url of attempts) {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() < 400) {
      const data = JSON.parse(response.getContentText());
      data.attribution = CONFIG.attribution;
      return data;
    }
    lastError = `${response.getResponseCode()} ${response.getContentText()}`;
  }

  throw new Error(`Open-Meteo request failed: ${lastError}`);
}

function buildDailyWeatherOutfits_(weather, now) {
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return [
    buildDayWeatherOutfit_(weather, today, '今日'),
    buildDayWeatherOutfit_(weather, tomorrow, '明日'),
  ];
}

function buildDayWeatherOutfit_(weather, date, label) {
  const dateKey = formatDateKey_(date);
  const periods = PERIODS.map(period => summarizePeriod_(weather, dateKey, period));
  return {
    label,
    dateKey,
    periods,
    dayAdvice: buildDayAdvice_(periods),
  };
}

function summarizePeriod_(weather, dateKey, period) {
  const hourly = weather.hourly || {};
  const rows = [];

  (hourly.time || []).forEach((time, index) => {
    if (!String(time).startsWith(dateKey)) return;
    const hour = Number(String(time).slice(11, 13));
    if (hour < period.startHour || hour > period.endHour) return;

    rows.push({
      temp: readNumber_(hourly.temperature_2m, index),
      apparent: readNumber_(hourly.apparent_temperature, index),
      humidity: readNumber_(hourly.relative_humidity_2m, index),
      precipitation: readNumber_(hourly.precipitation, index),
      precipitationProbability: readNumber_(hourly.precipitation_probability, index),
      weatherCode: readNumber_(hourly.weather_code, index),
      windSpeed: readNumber_(hourly.wind_speed_10m, index),
      windGust: readNumber_(hourly.wind_gusts_10m, index),
    });
  });

  const temps = rows.map(row => row.temp).filter(isFiniteNumber_);
  const apparentValues = rows.map(row => isFiniteNumber_(row.apparent) ? row.apparent : row.temp).filter(isFiniteNumber_);
  const humidityValues = rows.map(row => row.humidity).filter(isFiniteNumber_);
  const precipValues = rows.map(row => row.precipitation).filter(isFiniteNumber_);
  const precipProbValues = rows.map(row => row.precipitationProbability).filter(isFiniteNumber_);
  const windValues = rows.map(row => row.windSpeed).filter(isFiniteNumber_);
  const gustValues = rows.map(row => row.windGust).filter(isFiniteNumber_);
  const weatherCode = pickRepresentativeWeatherCode_(rows.map(row => row.weatherCode).filter(isFiniteNumber_));

  const summary = {
    label: period.label,
    tempMin: min_(temps),
    tempMax: max_(temps),
    tempAvg: avg_(temps),
    apparentMin: min_(apparentValues),
    apparentMax: max_(apparentValues),
    apparentAvg: avg_(apparentValues),
    humidityAvg: avg_(humidityValues),
    precipitationSum: sum_(precipValues),
    precipitationProbabilityMax: max_(precipProbValues),
    windMax: Math.max(max_(windValues) || 0, max_(gustValues) || 0),
    weatherCode,
    weatherLabel: weatherCodeToLabel_(weatherCode),
  };

  summary.outfit = buildOutfitAdvice_(summary);
  return summary;
}

function buildOutfitAdvice_(summary) {
  const feel = firstFinite_(summary.apparentAvg, summary.tempAvg, summary.tempMax, 20);
  const feelMin = firstFinite_(summary.apparentMin, summary.tempMin, feel);

  if (feel < 5) {
    return '🧥 ダウンジャケット＋厚手インナー';
  } else if (feel < 13) {
    return '🧥 ダウンまたは厚手ジャケット';
  } else if (feel < 21) {
    return '🧥 ジャケット＋Tシャツ';
  } else if (feel < 25) {
    return feelMin < 21 ? '👕 Tシャツ＋薄手の羽織り' : '👕 Tシャツ';
  } else {
    return '👕 Tシャツ';
  }
}

function buildDayAdvice_(periods) {
  const allTemps = periods.flatMap(period => [period.tempMin, period.tempMax]).filter(isFiniteNumber_);
  const minTemp = min_(allTemps);
  const maxTemp = max_(allTemps);
  const maxRain = max_(periods.map(period => period.precipitationProbabilityMax).filter(isFiniteNumber_));

  const notes = [];
  if (isFiniteNumber_(maxTemp) && maxTemp >= 33) {
    notes.push('🥵 暑い日です');
  } else if (isFiniteNumber_(minTemp) && minTemp <= 8) {
    notes.push('🧥 寒い日です');
  }
  if (isFiniteNumber_(maxRain) && maxRain >= 50) {
    notes.push('☔ 雨に注意');
  }
  return notes.length ? `${notes.join('。')}。` : '';
}

function buildPostContent_(days, now, weather) {
  const oneLine = generateGeminiWeatherOneLine_(days);
  return buildRuleBasedPostContent_(days, now, weather, oneLine);
}

function buildRuleBasedPostContent_(days, now, weather, oneLine) {
  const lines = [
    `天気予報（${CONFIG.locationName}）`,
    `自動投稿: ${Utilities.formatDate(now, CONFIG.timezone, 'yyyy/MM/dd HH:mm')}`,
  ];
  if (oneLine) lines.push('', `今日の一言: ${oneLine}`);

  days.forEach(day => {
    lines.push('', `## ${day.label}（${formatDateWithWeekday_(day.dateKey)}）`);
    if (day.dayAdvice) lines.push(day.dayAdvice);
    lines.push('');
    lines.push('| 時間帯 | 天気 | 気温 | メモ | 服装 |');
    lines.push('|---|---|---|---|---|');
    day.periods.forEach(period => {
      lines.push([
        period.label,
        formatWeatherWithRainProbability_(period),
        formatRange_(period.tempMin, period.tempMax),
        formatComfortMemo_(period),
        period.outfit,
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    });
  });

  lines.push('', weather.attribution || CONFIG.attribution);
  return lines.join('\n');
}

function generateGeminiWeatherOneLine_(days) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return '';

  const model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || 'gemini-3.1-flash-lite';
  const prompt = [
    '以下の天気データを見て、日記の天気予報に添える「今日の一言」を日本語で1文だけ作ってください。',
    '条件: 35文字以内。絵文字は最大1つ。服装名は書かない。体感温度の数値は書かない。前置き不要。',
    '',
    JSON.stringify(days[0]),
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 80 },
    }),
  });

  if (response.getResponseCode() >= 400) {
    console.warn(`Gemini failed: ${response.getResponseCode()} ${response.getContentText()}`);
    return '';
  }

  const data = JSON.parse(response.getContentText());
  const text = (data.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text || '')
    .join('\n')
    .trim();

  return text ? text.replace(/^今日の一言[:：]\s*/, '').split('\n')[0].trim() : '';
}

function buildWeatherMessage_(dateKey, content, now) {
  const iso = now.toISOString();
  return {
    id: `auto-weather-${dateKey}`,
    type: 'text',
    content,
    timestamp: Utilities.formatDate(now, CONFIG.timezone, 'HH:mm'),
    createdAt: iso,
    updatedAt: iso,
    source: 'apps-script-weather',
    autoType: 'weather-outfit',
  };
}

function upsertDiaryMessage_(dateKey, message) {
  const folder = getOrCreateFolder_(CONFIG.folderName);
  const file = getOrCreateJsonFile_(folder, CONFIG.diaryFileName);
  const notes = readJsonFile_(file);

  const existingDay = Array.isArray(notes[dateKey]) ? notes[dateKey] : [];
  const existing = existingDay.find(item => item.id === message.id);
  if (existing?.createdAt) message.createdAt = existing.createdAt;

  notes[dateKey] = [
    ...existingDay.filter(item => item.id !== message.id),
    message,
  ];

  file.setContent(JSON.stringify(notes, null, 2));
}

function getOrCreateFolder_(name) {
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function getOrCreateJsonFile_(folder, name) {
  const files = folder.getFilesByName(name);
  if (files.hasNext()) return files.next();
  return folder.createFile(name, '{}', MimeType.JSON);
}

function readJsonFile_(file) {
  const text = file.getBlob().getDataAsString('UTF-8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`diary_data.jsonのJSON解析に失敗しました: ${err.message}`);
  }
}

function weatherCodeToLabel_(code) {
  const labels = {
    0: '☀️ 快晴',
    1: '☀️ 晴れ',
    2: '🌤️ 一部くもり',
    3: '☁️ くもり',
    45: '🌫️ 霧',
    48: '🌫️ 霧氷',
    51: '🌦️ 弱い霧雨',
    53: '🌦️ 霧雨',
    55: '🌧️ 強い霧雨',
    61: '🌦️ 弱い雨',
    63: '🌧️ 雨',
    65: '🌧️ 強い雨',
    71: '🌨️ 弱い雪',
    73: '🌨️ 雪',
    75: '❄️ 強い雪',
    80: '🌦️ 弱いにわか雨',
    81: '🌧️ にわか雨',
    82: '⛈️ 強いにわか雨',
    95: '⛈️ 雷雨',
    96: '⛈️ 雷雨',
    99: '⛈️ 強い雷雨',
  };
  return labels[Math.round(code)] || '❔ 天気不明';
}

function pickRepresentativeWeatherCode_(codes) {
  if (!codes.length) return NaN;
  const severity = code => {
    if ([95, 96, 99].includes(code)) return 8;
    if ([71, 73, 75].includes(code)) return 7;
    if ([65, 82].includes(code)) return 6;
    if ([61, 63, 80, 81].includes(code)) return 5;
    if ([51, 53, 55].includes(code)) return 4;
    if ([45, 48].includes(code)) return 3;
    if (code === 3) return 2;
    if ([1, 2].includes(code)) return 1;
    return 0;
  };
  return codes.reduce((best, code) => severity(code) > severity(best) ? code : best, codes[0]);
}

function formatDateKey_(date) {
  return Utilities.formatDate(date, CONFIG.timezone, 'yyyy-MM-dd');
}

function formatDateWithWeekday_(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return `${dateKey}（${weekdays[date.getDay()]}）`;
}

function toQueryString_(params) {
  return Object.keys(params)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
}

function readNumber_(array, index) {
  if (!array || array[index] === null || array[index] === undefined) return NaN;
  const value = Number(array[index]);
  return Number.isFinite(value) ? value : NaN;
}

function isFiniteNumber_(value) {
  return Number.isFinite(value);
}

function firstFinite_(...values) {
  return values.find(isFiniteNumber_);
}

function min_(values) {
  const finite = values.filter(isFiniteNumber_);
  return finite.length ? Math.min(...finite) : NaN;
}

function max_(values) {
  const finite = values.filter(isFiniteNumber_);
  return finite.length ? Math.max(...finite) : NaN;
}

function avg_(values) {
  const finite = values.filter(isFiniteNumber_);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : NaN;
}

function sum_(values) {
  const finite = values.filter(isFiniteNumber_);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) : NaN;
}

function formatNumber_(value, digits = 0) {
  return isFiniteNumber_(value) ? String(Math.round(value * Math.pow(10, digits)) / Math.pow(10, digits)) : '-';
}

function formatRange_(minValue, maxValue) {
  if (!isFiniteNumber_(minValue) && !isFiniteNumber_(maxValue)) return '-';
  if (!isFiniteNumber_(minValue)) return `${formatNumber_(maxValue)}度`;
  if (!isFiniteNumber_(maxValue)) return `${formatNumber_(minValue)}度`;
  if (Math.round(minValue) === Math.round(maxValue)) return `${formatNumber_(minValue)}度`;
  return `${formatNumber_(minValue)}〜${formatNumber_(maxValue)}度`;
}

function formatComfortMemo_(period) {
  return [
    formatHumidityFeel_(period),
    formatWindFeel_(period),
  ].filter(Boolean).join('・') || '-';
}

function formatWeatherWithRainProbability_(period) {
  const probability = period.precipitationProbabilityMax;
  if (!isFiniteNumber_(probability)) return period.weatherLabel;
  return `${period.weatherLabel}（降水${formatNumber_(probability)}%）`;
}

function formatHumidityFeel_(period) {
  const humidity = firstFinite_(period.humidityAvg, NaN);
  const temp = firstFinite_(period.tempAvg, NaN);
  const feel = firstFinite_(period.apparentAvg, temp);
  if (!isFiniteNumber_(humidity)) return '💧 湿度不明';

  if (isFiniteNumber_(feel) && feel >= 32 && humidity >= 65) return '🥵 かなり蒸し暑い';
  if (isFiniteNumber_(feel) && feel >= 28 && humidity >= 60) return '💦 蒸し暑い';
  if (isFiniteNumber_(feel) && feel >= 30) return '💧 ややムシムシ';
  if (humidity >= 80) return '💧 しっとり湿度高め';
  if (humidity >= 65) return '💧 ややムシムシ';
  if (isFiniteNumber_(temp) && temp >= 28) return '🌿 湿度ふつう';
  if (humidity >= 45) return '🌿 湿度ふつう';
  return '🏜️ 乾燥気味';
}

function formatWindFeel_(period) {
  const wind = firstFinite_(period.windMax, NaN);
  if (!isFiniteNumber_(wind)) return '🍃 風不明';

  if (wind < 2) return '🍃 ほぼ無風';
  if (wind < 8) return '🍃 弱い風';
  if (wind < 18) return '🌬️ 風あり';
  if (wind < 30) return '🌬️ 強めの風';
  return '💨 強風';
}

function formatRainFeel_(period) {
  const probability = period.precipitationProbabilityMax;
  const precipitation = firstFinite_(period.precipitationSum, 0);

  if (isFiniteNumber_(probability)) {
    if (probability < 20) return '';
    if (probability < 40) return `🌂 念のため傘（${formatNumber_(probability)}%）`;
    if (probability < 70) return `☔ 雨に注意（${formatNumber_(probability)}%）`;
    return `☔ 雨高め（${formatNumber_(probability)}%）`;
  }

  if (!isFiniteNumber_(precipitation) || precipitation <= 0) return '';
  if (precipitation < 1) return `🌂 小雨かも（${formatNumber_(precipitation, 1)}mm）`;
  if (precipitation < 5) return `☔ 雨（${formatNumber_(precipitation, 1)}mm）`;
  return `⛈️ 強い雨（${formatNumber_(precipitation, 1)}mm）`;
}
