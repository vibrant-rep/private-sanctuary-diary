const CONFIG = {
  folderName: 'MyPrivateSanctuary_Sync',
  diaryFileName: 'diary_data.json',
  timezone: 'Asia/Tokyo',
  latitude: 35.6896,
  longitude: 139.7006,
  locationName: '東京・新宿',
  attribution: 'Weather data by Open-Meteo.com',
  weatherEndpoint: 'https://api.open-meteo.com/v1/jma',
};

const PERIODS = [
  { key: 'morning', label: '朝', startHour: 6, endHour: 9 },
  { key: 'daytime', label: '昼', startHour: 11, endHour: 15 },
  { key: 'evening', label: '晩', startHour: 18, endHour: 22 },
];

function postDailyWeatherOutfit() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const now = new Date();
    const todayKey = formatDateKey_(now);
    const weather = fetchWeatherForecast_();
    const days = buildDailyWeatherOutfits_(weather, now);
    const content = buildPostContent_(days, now);
    upsertDiaryMessage_(todayKey, buildWeatherMessage_(todayKey, content, now));
  } finally {
    lock.releaseLock();
  }
}

function runWeatherOutfitOnceForTest() {
  postDailyWeatherOutfit();
}

function installMorningWeatherTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'postDailyWeatherOutfit')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('postDailyWeatherOutfit')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .inTimezone(CONFIG.timezone)
    .create();
}

function fetchWeatherForecast_() {
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
      return JSON.parse(response.getContentText());
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
  const tempMin = firstFinite_(summary.apparentMin, summary.tempMin, feel);
  const humidity = firstFinite_(summary.humidityAvg, 0);
  const wind = firstFinite_(summary.windMax, 0);
  const rainLikely = firstFinite_(summary.precipitationProbabilityMax, 0) >= 50 || firstFinite_(summary.precipitationSum, 0) >= 1;
  const muggy = feel >= 25 && humidity >= 70;
  const windyCold = feel < 18 && (wind >= 7 || feel <= firstFinite_(summary.tempAvg, feel) - 3);
  const hot = feel >= 28;
  const veryHot = feel >= 32;

  let base;
  if (feel < 5) {
    base = 'ダウンジャケット＋厚手インナー';
  } else if (feel < 13) {
    base = 'ダウンまたは厚手ジャケット';
  } else if (feel < 21) {
    base = 'ジャケット＋Tシャツ';
  } else if (feel < 28) {
    base = tempMin < 21 ? 'Tシャツ＋薄手の羽織り' : 'Tシャツ中心';
  } else {
    base = 'Tシャツのみ';
  }

  const notes = [];
  if (muggy) notes.push('蒸し暑いので通気性重視');
  if (veryHot) notes.push('水分補給と日差し対策を優先');
  if (windyCold) notes.push('風を通しにくい上着が安心');
  if (rainLikely) notes.push('傘と濡れてもよい靴');
  if (!hot && firstFinite_(summary.tempMax, feel) - firstFinite_(summary.tempMin, feel) >= 7) notes.push('脱ぎ着しやすく');

  return notes.length ? `${base}。${notes.join('、')}。` : `${base}。`;
}

function buildDayAdvice_(periods) {
  const allTemps = periods.flatMap(period => [period.tempMin, period.tempMax]).filter(isFiniteNumber_);
  const allApparent = periods.flatMap(period => [period.apparentMin, period.apparentMax]).filter(isFiniteNumber_);
  const minFeel = min_(allApparent.length ? allApparent : allTemps);
  const maxFeel = max_(allApparent.length ? allApparent : allTemps);
  const maxRain = max_(periods.map(period => period.precipitationProbabilityMax).filter(isFiniteNumber_));
  const maxWind = max_(periods.map(period => period.windMax).filter(isFiniteNumber_));
  const allDayHot = isFiniteNumber_(minFeel) && minFeel >= 25;
  const veryHot = isFiniteNumber_(maxFeel) && maxFeel >= 35;

  const notes = [];
  if (allDayHot) {
    notes.push('体感は一日を通して高めなので、基本はTシャツのみでよさそうです');
  }
  if (veryHot) {
    notes.push('昼は体感温度がかなり高く、羽織りよりも水分補給・日差し対策・通気性を優先したい日です');
  }
  if (!allDayHot && isFiniteNumber_(minFeel) && isFiniteNumber_(maxFeel) && maxFeel - minFeel >= 8) {
    notes.push('朝晩と昼の体感差が大きいので、脱ぎ着しやすい服装がよさそうです');
  }
  if (isFiniteNumber_(maxRain) && maxRain >= 50) {
    notes.push('雨具を持って出るのが安心です');
  }
  if (!allDayHot && isFiniteNumber_(maxWind) && maxWind >= 8) {
    notes.push('風が強めなので、軽すぎる羽織りより風を通しにくいものが向いています');
  }
  if (!notes.length) notes.push('大きな注意点は少なく、時間帯ごとの気温に合わせればよさそうです');
  return notes.join('。') + '。';
}

function buildPostContent_(days, now) {
  const ruleBased = buildRuleBasedPostContent_(days, now);
  const aiText = generateGeminiWeatherComment_(ruleBased, days);
  return aiText || ruleBased;
}

function buildRuleBasedPostContent_(days, now) {
  const lines = [
    `天気と服装メモ（${CONFIG.locationName}）`,
    `自動投稿: ${Utilities.formatDate(now, CONFIG.timezone, 'yyyy/MM/dd HH:mm')}`,
    '',
    '朝昼晩の体感温度、湿度、風、雨を見て服装を分けています。',
  ];

  days.forEach(day => {
    lines.push('', `## ${day.label}（${day.dateKey}）`, day.dayAdvice, '');
    lines.push('| 時間帯 | 天気 | 気温・体感 | 湿度/風/雨 | 服装 |');
    lines.push('|---|---|---|---|---|');
    day.periods.forEach(period => {
      lines.push([
        period.label,
        period.weatherLabel,
        `${formatRange_(period.tempMin, period.tempMax)} / 体感${formatRange_(period.apparentMin, period.apparentMax)}`,
        `湿度${formatNumber_(period.humidityAvg)}%・風${formatNumber_(period.windMax)}km/h・雨${formatRain_(period)}`,
        period.outfit,
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    });
  });

  lines.push('', CONFIG.attribution);
  return lines.join('\n');
}

function generateGeminiWeatherComment_(ruleBased, days) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return '';

  const model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const prompt = [
    '以下の天気データと機械判定をもとに、日記へ自動投稿する文章を日本語で作ってください。',
    '条件:',
    '- 今日と明日を分ける',
    '- 朝・昼・晩ごとに天気、体感、服装を簡潔に残す',
    '- 気温だけでなく湿度、風、雨による体感も反映する',
    '- 体感温度が一日中25度以上なら、脱ぎ着や羽織りより暑さ対策を優先する',
    '- 風が強くても暑い日は防風上着を勧めず、通気性と水分補給を優先する',
    '- Markdownの表を使ってよい',
    '- 余計な前置きは不要',
    '',
    ruleBased,
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 900 },
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

  return text ? `${text}\n\n${CONFIG.attribution}` : '';
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
    0: '快晴',
    1: '晴れ',
    2: '一部くもり',
    3: 'くもり',
    45: '霧',
    48: '霧氷',
    51: '弱い霧雨',
    53: '霧雨',
    55: '強い霧雨',
    61: '弱い雨',
    63: '雨',
    65: '強い雨',
    71: '弱い雪',
    73: '雪',
    75: '強い雪',
    80: '弱いにわか雨',
    81: 'にわか雨',
    82: '強いにわか雨',
    95: '雷雨',
    96: '雷雨',
    99: '強い雷雨',
  };
  return labels[Math.round(code)] || '天気不明';
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

function formatRain_(period) {
  const precipitation = isFiniteNumber_(period.precipitationSum) ? `${formatNumber_(period.precipitationSum, 1)}mm` : '-mm';
  if (!isFiniteNumber_(period.precipitationProbabilityMax)) return precipitation;
  const probability = `${formatNumber_(period.precipitationProbabilityMax)}%`;
  return `${probability}/${precipitation}`;
}
