// ブーム荷重検索（oncraneから移植・型注釈を削除）

const sortedRadii = (loads) =>
  Object.keys(loads).map(Number).sort((a, b) => a - b);

// 指定半径で各ID（ブーム長）の最大荷重を返す
export function searchByRadius(loadData, blockMap, idOrder, mode, radius) {
  const modeData = loadData[mode];
  if (!modeData) return [];

  const results = [];
  for (const id of idOrder) {
    const radiusData = modeData[id];
    if (!radiusData) continue;
    const blockInfo = blockMap[id];
    if (!blockInfo) continue;

    const radii = sortedRadii(radiusData);
    if (radii.length === 0) continue;
    if (radius > radii[radii.length - 1]) continue;

    let matchedRadius = null;
    for (let j = 0; j < radii.length; j++) {
      if (radii[j] === radius) {
        matchedRadius = radii[j];
        break;
      } else if (radii[j] > radius) {
        matchedRadius = j > 0 ? radii[j - 1] : radii[0];
        break;
      }
    }
    if (matchedRadius !== null) {
      results.push({
        id,
        block: blockInfo.block,
        boomLength: blockInfo.length,
        description: blockInfo.description,
        matchedRadius,
        load: radiusData[matchedRadius],
      });
    }
  }
  return results;
}

// 結果を荷重大きい順にソート
export function sortRadiusResults(results) {
  return [...results].sort((a, b) => b.load - a.load);
}

// 指定半径で吊上げ可能な「最大荷重」とそのブーム長を1つ返す（ベストマッチ）
export function bestLoadAtRadius(loadData, blockMap, idOrder, mode, radius) {
  const r = sortRadiusResults(searchByRadius(loadData, blockMap, idOrder, mode, radius));
  return r.length > 0 ? r[0] : null;
}
