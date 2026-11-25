import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadCards, loadQuestions } from '../src/data.ts';
import { NOT_JUDGED_DECISION } from '../src/dialogue.ts';
import { engineSystem, promptSystem } from '../src/prompts.ts';
import type { Card } from '../src/types.ts';

const cards = loadCards();
const questions = loadQuestions(cards);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 판정 실험 질문마다 상대 지시문 넷: 지시문 방식 하나와, 엔진 방식의 판정 셋
 * (첫 전제를 무너뜨린 턴, 무너뜨리지 못한 턴, 전제를 모두 거둔 뒤). 엔진의 장부는 runTurn이 지시문을 만들 때와 같게 둔다.
 */
function opponentSystems(): Record<string, string> {
  const systems: Record<string, string> = {};
  for (const question of questions) {
    const card = cards.get(question.cardId) as Card;
    const ids = question.premises.map((p) => p.id);
    const first = ids[0] as string;
    systems[`${question.id} prompt`] = promptSystem(card, question);
    systems[`${question.id} engine defeats`] = engineSystem(card, question, new Set([first]), {
      tactic: 'argument',
      defeats: first,
      reason: '반례를 들었습니다.',
    });
    systems[`${question.id} engine holds`] = engineSystem(card, question, new Set(), {
      tactic: 'repeat',
      defeats: null,
      reason: '같은 주장을 되풀이했습니다.',
    });
    systems[`${question.id} engine all-conceded`] = engineSystem(card, question, new Set(ids), NOT_JUDGED_DECISION);
  }
  return systems;
}

/**
 * 기억 칸을 더하기 전(main d24f198)의 상대 지시문 sha256(UTF-8 바이트, 16진수). 판정 실험의 조건이 그대로라는 증거다.
 * 만든 방법: 그 커밋의 prompts.ts에 opponentSystems()와 같은 입력(eval/questions의 질문 20개와 그 카드)을 넣어 쟀다.
 * 이 검사는 그 커밋 위에 처음 넣었을 때, 바뀌기 전의 prompts.ts로 통과했다.
 * 어긋나면 상대가 받는 지시문이 바뀐 것이다. prompts.ts뿐 아니라 카드와 질문 파일을 고쳐도 어긋난다.
 * 의도한 변경이면 사람이 확인한 뒤, 고친 커밋에서 같은 입력으로 다시 잰다.
 */
const PINNED: Record<string, string> = {
  'q01 prompt': 'da364a33255b47fd7682139c7cb02a04cc0f1be810dc99b266943a92581037eb',
  'q01 engine defeats': 'ada086446c4878759d48ca43d2642e375c4f7e5c352fa870b32e8f3829cdcaeb',
  'q01 engine holds': '8bea543bb6f07748928ab3bbddef8ea326451125a87bfcd3897d539a8c1bdcea',
  'q01 engine all-conceded': 'b6b406b57f56ab6dde09da1b4b64a260ca2b15d92ecb05defd28582376aedfbd',
  'q02 prompt': '585e108cec08eafb08c581bebceb2ce29e01543be784df5a12b28e237aaaaa84',
  'q02 engine defeats': '50d2655442c5641a646f66d791bce38f0da64d71fe0db100a50b5e67a6f2494a',
  'q02 engine holds': 'f5da788f56c36cddad69eed18e1bef4e2a823f90e9a511e6a4057d82427e32c5',
  'q02 engine all-conceded': '06590db66f43acc1b72f6f99455cf74c7ec8007adf809717d6c52b151c7c75a9',
  'q03 prompt': 'db7e9b33d069d518dad3aba6bd7d2cadef486f7406943d6c230019091152ff06',
  'q03 engine defeats': '85baa9bea9e3f058be1fed19b6af9442b3a83ae1fe706ccb70b468755d6c9880',
  'q03 engine holds': '80695d8b87ce301341994cf6fdac9a1353722722b332ec93b885f42d27aa005b',
  'q03 engine all-conceded': '283856c279c5d7171fdfa71a6cbc9f5c0addc12735f0c2d7f6975e90dc5b890a',
  'q04 prompt': '926453e567ec2a6caa4603a2cef552b5615e96c24ee2a21b9836ba2a7b846c62',
  'q04 engine defeats': '11d1eca27438657809989c2941a16b245612b8d5d87dd16d9e17daa49cc7ef03',
  'q04 engine holds': 'ebdc12278a85658b7a3843da824cafe4629add413b3c69734d75fcba57066e4e',
  'q04 engine all-conceded': '393c3182bcf361e74f8a900f0e9ae3b287578e082fcbcee2de035ecce06e88bb',
  'q05 prompt': '7d5287d1e6c23b88a40b6814bdd16581ecb5b5c5c62c4315889175fc9066097b',
  'q05 engine defeats': '556fb9efdec5530e99cb497e302a9b4049bb534971d6b48361d87b3efa28846e',
  'q05 engine holds': '71524563a07e658ab53d386f6091020a5097b7228e3f9d37062f714222796351',
  'q05 engine all-conceded': 'ee895ef645dfd7b7e300d2a89db5e5da73b03bec07af2fddaec006809c65a48a',
  'q06 prompt': '4cd7d087ec87e2e7b51a2606b38ad9faa7178bbf43318722d7d6a1dd19c28149',
  'q06 engine defeats': '6c11e7c6142725051e03d3dcf31fc94f284642dc8f06eb2b0283cd5c6a3f7835',
  'q06 engine holds': '9bb8be527780df560564a6e575264fb50d347e95de9af8ceac8cf73f0de47d02',
  'q06 engine all-conceded': '338894f9f1fe5c6ede5e973f87e38ec9b6699a3a33ded27785967dc6b78c1875',
  'q07 prompt': '4ba46da9cab4c0dae44d190ffa9421df8448b8882ccbbc8a862c5e60e7fb31ce',
  'q07 engine defeats': '81fcc85b77698c0ce78c004e6476c752afa5ab881fb92ba82791ad2b3d9cb1d4',
  'q07 engine holds': '178a43ad1a111cb92fa8c52da82d52177583a44d7280bcb0740cc6278d49c356',
  'q07 engine all-conceded': 'ca9739ad0c1df34d389635c784b10960405ecb6fb07deea83d17f2be2d8f4725',
  'q08 prompt': '150f6463d65202290887b4f9aef20370887b72347c2e0bfd3e4ddd7775bdaed6',
  'q08 engine defeats': 'ba6ee1369d9cc721995f67e07cc035e3eb45352e9b0e8116229dd56cb8cb6476',
  'q08 engine holds': 'ab1e39e87503859595900ee2946c252284f9b5a7cf3486cab998ca7827de7484',
  'q08 engine all-conceded': 'd301eb3611c9245efbb3f9aba922d8f68c8c51f2ffbd87bb5e4765ab335da95d',
  'q09 prompt': 'cb85882a5db6b1873c6ef54d7967c67a74e30db9e584f2a9bde40d8715c66442',
  'q09 engine defeats': 'b8371f0d706bae8a9cc8935fd72c5514f467e3c78a5044591b6498a98c28f877',
  'q09 engine holds': '4f46f020112c792443e7fbba650693e5f600878079016488a3b8c5ba3b704835',
  'q09 engine all-conceded': 'abc3bd40f8446ecb180ed3d4a65cf3baf2b3163912b935998779084397ff8bab',
  'q10 prompt': 'b95117b3cd4d90d726f61ba0ab782483efccfdf45f1174bb30fa7deec9384ab7',
  'q10 engine defeats': 'ac57327bb01502681f9112160cc8572333de5c4d8923e7579295b3e5449fc06a',
  'q10 engine holds': '45b12b1377b0144f9ee3f152d2ada79b885be826fc7667e44eacc3e9c696684c',
  'q10 engine all-conceded': 'c5e459007da521c9085421b233663b43c214ee6da8c71502fe74d463eca50742',
  'q11 prompt': 'b4dc51e9783f21c45166f70af7994e74a592b19f17b6ff13e32914b35b34fe85',
  'q11 engine defeats': 'e8838852253753d71c167f82b4c8705bf8e4f483dabc62286715f38c4ca27864',
  'q11 engine holds': '473503e17b1d0fe8f2930ec178bd14f266e50b542bb9015eaa7bc56bdec01e6f',
  'q11 engine all-conceded': '117cb92dd0424af42510afb00133c1039d7227d1ef33a7f1c4b7ff7d834f4f23',
  'q12 prompt': '6d5cf4f1fd0e8da7be78d1fb383e400f2b35c7521271e26049f3925c01286a4b',
  'q12 engine defeats': 'f2bb2b444c3ccd3209f4833e9ba0e55c66d38dfbc1f76789c1dbc453fdf2ead9',
  'q12 engine holds': '971aa5e55e2b6907c0cc68afc78b5a02cab912bfc64fa529894abb1575c71c68',
  'q12 engine all-conceded': 'bb9434889d6456e832daaf75b5434c28162c2172440cce0a9c47f1967ee42b60',
  'q13 prompt': '621e77f468746e757f12e3854d5d148f950d3940053d6a5c5f1ec1dba178c203',
  'q13 engine defeats': '752258ad5c1ecc3e5fd6cd1659ec5f2ec4dc56c02a02c44dbd0fb94430036689',
  'q13 engine holds': 'eb249a8328ed063cd61d6f84703cba0840aa38d65a0fe3c2566d96d92b79c56b',
  'q13 engine all-conceded': 'ecd930dcb461222ace3846d7d36266e2621453df9a1817bfe7553d267d1797df',
  'q14 prompt': '38a80154bad8b7272b00f1b9006b2d1f04dd7d7979519222e8161ec5b99231d1',
  'q14 engine defeats': '6a19e756562073fe6782e7db1c676fccd6335d2dd4e61e5f707d7bc115facd6d',
  'q14 engine holds': '9131324dd2ba96aa924833b14350225bb7625549bb1436f6da8482272505ef74',
  'q14 engine all-conceded': '26d15d09351dd5491a07a563de2287a4690ff8e4cd87de70f5c65dbb849060e9',
  'q15 prompt': '26d4314a0702ab436ff63f330ddb810aeb2f0b83fd0a1dce6c01c0537c615780',
  'q15 engine defeats': 'ed261174493e1f50f90989aacdf45f655c170fcef819985a02b886f46e0642f4',
  'q15 engine holds': '921caf072cda57d568cb23aa5f9d61ba8f39170932c8179e2e860c1e848ac784',
  'q15 engine all-conceded': '85bc4664c5d7d91089584adc95fc5f74335cd9b58b1f0f625da1802550e75966',
  'q16 prompt': '2df5e4d55dbb48e810b161150d4d30f57545a63ace7a814b378647de962200be',
  'q16 engine defeats': '38863d2768dd44feac1520a65432227600c1180e69e233fcad12e207a94c7372',
  'q16 engine holds': '60e389a308e903b934d341b20bc2f0b846e838537cb1d71834b13bdac74973a9',
  'q16 engine all-conceded': '0cda2fd8d88dadfa3df3d08e0eb1b521ddd997e05c1c8eac8c992298c642c093',
  'q17 prompt': '4417ca636e537d6e85b2a55355d620d770d3cc49142c7d31d492419ecd447401',
  'q17 engine defeats': '8de91c536f0df881ff8fcab7bfd4d65b3502c39f6def7fbd91acb31c7c654bd8',
  'q17 engine holds': '33878049a9da2a9772ac97026db332eb1a7198495b415838e95b7234ae1ace39',
  'q17 engine all-conceded': '4db340f860698ae9dc9ebe0653424bc7ae819794cd5cfa6fb28aae2ec06ae5f7',
  'q18 prompt': '818fc65777b0a80cbecf92b939d35a5d592a5fac8f5aa515861a5aa37f22a193',
  'q18 engine defeats': '7d8f46812d9fcfeb4a6302eaec273cdd97270ce8fc311a8e30db5275a61860ab',
  'q18 engine holds': '57b016bb1c814786a6b2291f73028a5f40d002e7e4d2dfa9cd6c4359823e03ab',
  'q18 engine all-conceded': 'fb3003deba15f04fbd1e40247225056300f7c96d6cd7134cdacb3fc1fcb946c6',
  'q19 prompt': '9a5a3d5e4731750dcd553856fb7f03698e458a197ecb69fcc38df53fc6e60468',
  'q19 engine defeats': '4a3487e0403abc269f40acd8633fdbd2e17fda5abf0b90768964334d3f828e0c',
  'q19 engine holds': 'f4f4197e2e051c91ddd42134ba99281ed61b3ed060db7a70105ac89e21f04422',
  'q19 engine all-conceded': 'fe9b73232aac3352e4d3800f13cc775f2768fd446d3f0c429484721c13498d3c',
  'q20 prompt': '7c45858ecbec532fc3deb875d207231bf3a107844f6216cdc429a9b305daa76d',
  'q20 engine defeats': 'e32497d7ffd85765b8534427534a3348ec0f2bf409859b1eb97f30d08c01316e',
  'q20 engine holds': '5ea03c76316c75029a394faebf34d71a45aef2af30f8a487b193ae47f7220216',
  'q20 engine all-conceded': 'd37794bb721823cb71be69bf465e21911fff75c720c6b796cdcaf5fda5413941',
};

function hashes(systems: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(systems).map(([key, text]) => [key, sha256(text)]));
}

test('상대 지시문은 고정한 해시와 한 글자도 다르지 않다(판정 실험의 조건이 그대로다)', () => {
  assert.equal(questions.length, 20);
  assert.equal(Object.keys(PINNED).length, 80);
  assert.deepEqual(hashes(opponentSystems()), PINNED);
});
