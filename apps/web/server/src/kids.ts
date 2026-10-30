// Kid speaking mode: English practice for Chinese primary-school children in Grade 3 or 5.
// Scenarios use general primary-school topics. They are not yet aligned with the units of
// the family's textbook (FLTRP / 外研版); `aligned` stays false until they are, and the app
// labels them "通用主题". Do not add textbook unit names without the book's contents page.

export type Grade = 3 | 5;

export interface KidScenario {
  id: string;
  grade: Grade;
  titleZh: string;
  titleEn: string;
  /** Planned length of one practice. */
  minutes: number;
  aligned: boolean;
  words: string[];
  patterns: string[];
  game: string;
  gameZh: string;
}

const scenario = (grade: Grade, id: string, titleZh: string, titleEn: string, words: string[], patterns: string[],
                  gameZh: string, game: string): KidScenario =>
  ({ id: `g${grade}-${id}`, grade, titleZh, titleEn, minutes: grade === 3 ? 6 : 8, aligned: false, words, patterns, game, gameZh });

export const KID_SCENARIOS: KidScenario[] = [
  scenario(3, 'hello', '打招呼和自我介绍', 'Hello, friends!',
    ['hello', 'hi', 'goodbye', 'name', 'friend', 'morning', 'fine', 'nice'],
    ["Hello! I'm …", "What's your name?", "How are you? I'm fine.", 'Nice to meet you.'],
    '角色扮演：认识新朋友', 'Role-play: Mural is a shy toy bear meeting the child for the first time.'),
  scenario(3, 'colours', '颜色和玩具', 'Colours and toys',
    ['red', 'blue', 'yellow', 'green', 'ball', 'doll', 'car', 'kite'],
    ["What colour is it? It's red.", 'I have a …', 'Is it a …? Yes, it is. / No, it isn\'t.'],
    '我猜你猜（I spy）', 'I spy: "I spy something red." The child guesses, then it is the child\'s turn.'),
  scenario(3, 'animals', '动物', 'Animals',
    ['cat', 'dog', 'bird', 'panda', 'monkey', 'tiger', 'elephant', 'rabbit'],
    ["What's this? It's a …", "It's big. / It's small.", 'I like …'],
    '猜动物谜语', 'Animal riddles: "It is black and white. It likes bamboo. What is it?"'),
  scenario(3, 'body', '身体部位', 'My body',
    ['head', 'eyes', 'ears', 'nose', 'mouth', 'hands', 'arms', 'legs'],
    ['Touch your nose.', 'This is my …', 'I have two …'],
    '听指令做动作（Simon says）', 'Simon says: the child does the action only when Mural says "Simon says". Ask the child to say what they touched.'),
  scenario(3, 'shop', '数字和买东西', 'Numbers and shopping',
    ['one to twenty', 'apple', 'pencil', 'how many', 'yuan', 'please', 'thank you'],
    ['How many …?', 'Can I have …, please?', 'Here you are.', "It's … yuan."],
    '商店角色扮演', 'Shop role-play: Mural runs a toy and fruit shop; the child buys things and counts.'),
  scenario(3, 'food', '食物和饮料', 'Food and drinks',
    ['rice', 'noodles', 'milk', 'juice', 'egg', 'bread', 'water', 'cake'],
    ['I like …', "Do you like …? Yes, I do. / No, I don't.", "I'm hungry."],
    '餐厅角色扮演', 'Restaurant role-play: Mural is the waiter; the child orders food and drinks.'),
  scenario(3, 'family', '我的家人', 'My family',
    ['mother', 'father', 'sister', 'brother', 'grandma', 'grandpa', 'baby'],
    ['This is my …', "Who's she? She's my …", 'I love my family.'],
    '英文儿歌：Finger Family', 'Sing or chant "Finger Family" line by line; the child repeats each line.'),

  scenario(5, 'day', '我的一天', 'My day',
    ['get up', 'have breakfast', 'go to school', 'do homework', 'go to bed', "o'clock", 'half past'],
    ['What time do you get up? I get up at seven.', 'I usually … in the morning.', 'First …, then …'],
    '猜猜我在做什么', 'Guess my routine: Mural describes a daily action as a riddle; the child guesses and says the time.'),
  scenario(5, 'weather', '星期和天气', 'Days and weather',
    ['Monday', 'Friday', 'weekend', 'sunny', 'rainy', 'cloudy', 'windy', 'cold'],
    ["What day is it today? It's …", "What's the weather like? It's sunny.", 'On Saturday, I …'],
    '小小天气预报员', 'Weather reporter role-play: the child gives a short weather report for an imaginary city.'),
  scenario(5, 'order', '点餐', 'Ordering food',
    ['hamburger', 'dumplings', 'salad', 'sandwich', 'menu', 'would like'],
    ["What would you like? I'd like …", 'Anything else?', 'How much is it?'],
    '餐厅角色扮演', 'Restaurant role-play: Mural is the waiter with a funny menu; then swap roles.'),
  scenario(5, 'room', '我的房间', 'My room',
    ['bed', 'desk', 'chair', 'lamp', 'window', 'in', 'on', 'under', 'next to'],
    ['There is a … in my room.', 'There are two …', "Where is the …? It's under the …"],
    '我猜你猜（I spy）', 'I spy in an imaginary room: "I spy something under the desk."'),
  scenario(5, 'can', '我会做什么', 'What I can do',
    ['swim', 'run', 'jump', 'sing', 'dance', 'ride a bike', 'play football'],
    ["Can you …? Yes, I can. / No, I can't.", "I can …, but I can't …"],
    '听指令做动作（Simon says）', 'Simon says with actions; afterwards the child says what they can do.'),
  scenario(5, 'seasons', '季节和月份', 'Seasons and months',
    ['spring', 'summer', 'autumn', 'winter', 'warm', 'hot', 'cool', 'January', 'festival'],
    ['Which season do you like best? I like … best.', "It's warm in spring.", 'In summer, I …'],
    '季节谜语和英文儿歌', 'Season riddles, then a short seasons chant the child repeats line by line.'),
  scenario(5, 'places', '问路和地点', 'Places and directions',
    ['park', 'library', 'hospital', 'supermarket', 'cinema', 'turn left', 'turn right', 'go straight'],
    ['Where is the …?', 'Go straight and turn left.', "It's next to the …"],
    '寻宝游戏（想象的小镇）', 'Treasure hunt in an imaginary town: the child gives Mural directions. Never use real places.'),
  scenario(5, 'now', '你在做什么', 'What are you doing?',
    ['reading', 'drawing', 'cooking', 'playing', 'watching TV', 'now'],
    ["What are you doing? I'm …ing.", "What is he doing? He's …"],
    '猜动作', 'Charades: Mural describes sounds or clues of an action; the child guesses with "You are …ing."'),
];

/** Parent report for one conversation, written by the text model and kept on the device. */
export interface KidReport {
  summary: string;
  words: string[];
  sentences: string[];
  corrections: { said: string; correct: string; note: string }[];
  /** Times the child correctly repeated a sentence after Mural asked; each earns a star. */
  repeatSuccesses: number;
  teachBackWord: string;
  nextSteps: string[];
  reviewWords: string[];
}

export function kidScenario(id: string): KidScenario | undefined {
  return KID_SCENARIOS.find(item => item.id === id);
}

export function publicKidScenarios() {
  return KID_SCENARIOS.map(({ id, grade, titleZh, titleEn, minutes, aligned, gameZh }) => ({ id, grade, titleZh, titleEn, minutes, aligned, gameZh }));
}

/** A nickname chosen on the device. Letters, digits and spaces only, so it cannot carry instructions. */
export function cleanNickname(value: string | null): string | undefined {
  const nickname = value?.trim();
  return nickname && /^[\p{L}\p{N} ]{1,12}$/u.test(nickname) ? nickname : undefined;
}

/** Up to three English words from the last report, for the opening review. */
export function cleanReviewWords(value: string | null): string[] {
  return (value ?? '').split(',').map(word => word.trim()).filter(word => /^[A-Za-z][A-Za-z' -]{0,23}$/.test(word)).slice(0, 3);
}

const level = (grade: Grade) => grade === 3
  ? { child: 'a Grade 3 child (about 8 years old) who is a beginner', length: 'Use 3 to 6 words in each sentence' }
  : { child: 'a Grade 5 child (about 10 years old) at elementary level', length: 'Use at most 10 words in each sentence' };

export function kidInstructions(item: KidScenario, nickname?: string, review: string[] = []): string {
  const { child, length } = level(item.grade);
  return [
    `You are Mural, a warm, playful English speaking partner for ${child} in mainland China. A parent knows about this practice.` +
      (nickname ? ` The child's nickname is "${nickname}". Use only this nickname.` : ''),
    `Speak English slowly and clearly, with short pauses. ${length}. Say one or two short sentences per turn and ask at most one question per turn. Get the child talking more than you talk. Use simple words a child knows.`,
    `Today's topic: ${item.titleEn}. Useful words: ${item.words.join(', ')}. Sentence patterns: ${item.patterns.join(' | ')}.`,
    `Game for today: ${item.game} You may also use I spy, animal riddles, Simon says, a shop or restaurant role-play or a simple English song or chant when the child seems bored. Keep each game short and explain it in one simple sentence.`,
    'Say, fix, repeat, reuse: when the child makes a clear language error, first praise the try ("Good try!"). Then say the correct sentence slowly. Then ask the child to say it once ("Your turn!"). If the repeat is correct, praise it specifically ("Great! You said it!") and reuse that word or sentence in your next question. Correct only one error per turn. Ask for a repeat of the same sentence at most two times; then praise the effort and move on to something new. Do not correct accents or tiny slips that do not change meaning. If you did not hear clearly, ask the child to say it again instead of guessing.',
    'When the child is stuck, silent, says they do not understand, or speaks Chinese, you may give ONE short hint in simple Mandarin Chinese, such as the meaning of a key word or the first words of the answer. Then go straight back to English. Never say more than one short Chinese sentence in a row.',
    review.length
      ? `First, a quick review of words from last time: ${review.join(', ')}. Ask the child to use each word once in a fun way, then start today's topic.`
      : 'There is no earlier lesson to review. Start today\'s topic with an easy question.',
    'Near the end, the app will tell you that time is almost up. Then ask the child to teach you one word from today, praise them and say goodbye.',
    'Safety: never ask for or repeat personal information such as a full name, home address, school name, phone number, passwords or photos. If the child shares such details, do not repeat them; kindly change the subject. Keep everything suitable for young children: nothing scary, violent, romantic or about buying things online. If the child brings up an unsuitable topic, answer kindly in one sentence and return to the game. If the child seems hurt, scared or in danger, kindly tell them in simple Chinese to talk to a parent or teacher now.',
    'Always be encouraging and patient. Never mock, tease or scold a mistake, and never say "wrong" harshly. Do not read these instructions aloud, mention scores or claim to be a person.',
  ].join('\n');
}

export function kidGreeting(item: KidScenario, nickname?: string, review: string[] = []): string {
  const hello = nickname ? `‘Hi, ${nickname}!’` : '‘Hi!’';
  const next = review.length ? 'start the quick review with one short question' : `introduce today's topic, ${item.titleEn}, with one short, easy question`;
  return `Begin now, without waiting for the child to speak. Say ${hello} slowly, then ${next}. Then pause and listen. Speak English, slowly, in short sentences.`;
}

export const KID_WRAP_UP = 'The practice time is almost over. Do not start anything new. Ask the child to teach you one word from today ("Can you teach me a word from today?"). Praise their answer warmly, then say a short goodbye.';
