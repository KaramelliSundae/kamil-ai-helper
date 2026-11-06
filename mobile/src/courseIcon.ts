import type { ImageSourcePropType } from 'react-native';

import { icons } from './icons';

/** Course names come in Turkish or English, in any case: "İŞLETİM SİSTEMLERİ" and "isletim sistemleri" read the same. */
function plain(text: string): string {
  return text
    .replace(/[İI]/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c');
}

// The first match wins, so narrow subjects come before the wide ones that share their words:
// "Machine Learning" before machines, "Digital Design" before design, "Computer Networks" before computers.
const SUBJECTS: [RegExp, keyof typeof icons][] = [
  [/algorithm|algoritma/, 'accountTree'],
  [/operating system|isletim sistem/, 'terminal'],
  [/artificial|yapay zeka|machine learning|makine ogren|deep learning|derin ogren|neural|sinir ag/, 'psychology'],
  [/computer architecture|computer organi[sz]ation|bilgisayar mimari|bilgisayar organizasyon|microprocessor|mikroislemci|embedded|gomulu/, 'memory'],
  [/sayisal (analiz|yontem)|numerical/, 'functions'],
  [/digital|sayisal|logic design|mantik tasarim|circuit|devre|vlsi/, 'developerBoard'],
  [/network|aglari|telecom|iletisim sistem/, 'lan'],
  [/database|veri ?taban|data management/, 'database'],
  [/data structure|veri yapi/, 'schema'],
  [/software|yazilim|programming|programlama|coding|kodlama|object oriented|nesne yonelimli/, 'code'],
  [/statistic|istatistik|probabilit|olasilik|data science|veri bilimi/, 'barChart'],
  [/calculus|mathemat|matematik|\bmath\b|algebra|cebir|differential|diferansiyel|discrete|ayrik|geometr|\banaliz\b|\banalysis\b/, 'calculate'],
  [/electric|elektrik|electronic|elektronik|signal|sinyal|power system|guc sistem/, 'electricBolt'],
  [/physic|fizik/, 'bolt'],
  [/biolog|biyoloji|genetic|genetik|molecular|molekuler|microbio|mikrobiyo|biochem|biyokimya|biotech/, 'biotech'],
  [/chemi|kimya/, 'science'],
  [/histor|tarih|ataturk|inkilap/, 'historyEdu'],
  [/turkish|turkce|turk dili/, 'translate'],
  [/english|ingilizce|german|almanca|french|fransizca|spanish|ispanyolca|academic writing|akademik yazi/, 'language'],
  [/psycholog|psikoloji/, 'psychologyAlt'],
  [/philosoph|felsefe|ethic|\betik\b/, 'lightbulb'],
  [/societ|sociolog|sosyoloji|social|sosyal|toplum|community/, 'groups'],
  [/econom|ekonomi|iktisat|financ|finans|accounting|muhasebe|business|management|isletme|marketing|pazarlama|entrepreneur|girisim/, 'trendingUp'],
  [/\blaw\b|hukuk/, 'gavel'],
  [/geograph|cografya|international relations|uluslararasi|political|siyaset|government/, 'public'],
  [/literatur|edebiyat/, 'menuBook'],
  [/architect|mimar|urban|sehir planlama/, 'architecture'],
  [/mechanic|mekanik|machine|makine|thermo|termo|fluid|akiskan|statics|statik|dynamics|dinamik|material|malzeme|manufactur|imalat|civil|insaat|structural|engineering|muhendis/, 'engineering'],
  [/\barts?\b|sanat|music|muzik|design|tasarim|drawing|cizim|photograph|fotograf/, 'palette'],
  [/comput|bilgisayar|informatics|bilisim/, 'computer'],
];

/** An icon for what the course is about, or a plain school cap when its name gives no clue. */
export function courseIcon(course: string): ImageSourcePropType {
  const name = plain(course);
  const subject = SUBJECTS.find(([pattern]) => pattern.test(name));
  return icons[subject ? subject[1] : 'school'];
}
