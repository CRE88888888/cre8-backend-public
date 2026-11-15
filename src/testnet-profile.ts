import type { Address } from 'viem';

/** Generated from cre8-contracts deployments/testnet-97.json (manifest gitCommit below),
 * script/testnet/TestnetAssets.sol at b767bf6b22bb697a0b86abf8ed683916fe81502d.
 * Kernel/policy: pinned backend SDK versions, verified on the chain 97 fork.
 * Quoter: https://developer.pancakeswap.finance/contracts/v3/addresses (BSC TESTNET).
 * maxLegUsdt: conservative existing admission caps, db 0024 at 3dd4302;
 * new 54 assets: 5,000 MockUSDT per leg (C3 decision, backend#87), testnet only.
 * Existing launch caps copied by symbol at generation time, never looked up in the mainnet DB at runtime.
 */
export const TESTNET_97 = {
  "chainId": 97,
  "sourceCommit": "b767bf6b22bb697a0b86abf8ed683916fe81502d",
  "mode": "fork",
  "note": "fork = verified on a local anvil fork of chain 97; the public deployment lands on the same CREATE2 addresses",
  "verifiedAtBlock": 142841703,
  "generatedAt": "2026-11-15T08:27:14Z",
  "gitCommit": "b8517cc4848c69a974553782a810dace31d82383",
  "roles": {
    "deployer": "0x55662b4183fca1230694d5d57f56e4f2e0e3008a",
    "owner": "0x09bbb9a06a0c49ad24bddb18808944041783054e",
    "operator": "0xd8ce3295e05ca138e0d0d7214c4fd630c43f9d7f",
    "keeper": "0xa38ddfb9fdf0043cf61b00e1a8d12fa1431f92d5",
    "paymasterSigner": "0xf5645ff8fa773246010f7c9dddff8e590e800495",
    "feeRecipient": "0x3b5ede5af574e7d8f3b72143e09dc242dd1f0462",
    "bundlerExecutor": "0xcc0ea01356d75aa5295d364344753f136b77ee28",
    "bundlerUtility": "0x6735c14bf84c8cb0d64bf2fb51b7587ade7b2960"
  },
  "contracts": {
    "ownedDeployer": "0x35500b1dd850763fd67ed89a04abfe7a15c443a3",
    "registry": "0x88e5d2d14985f34539ffd67210f3d06963f3cce1",
    "router": "0x89652a2a95883a7939103364c7d32a5f1678307d",
    "executor": "0x78e03637a033b3b08c0fc7ed7d8540d992d1b0b7",
    "usdt": "0xbd7d814e02c9f69af391a8ba4c1787769f2ddd4b",
    "feed.USDT/USD": "0x9612a567213d3ced8d8328b34fcaf6685c73af02",
    "paymaster": "0xa8ac1cc4846f72a32af0302ae5ae03b1a8dbaafa",
    "gasPolicy": "0xaefc5abc67ffd258abd0a3e54f65e70326f84b23",
    "entryPoint": "0x0000000071727de22e5e9d8baf0edac6f37da032",
    "v3Factory": "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
    "positionManager": "0x427bf5b37357632377ecbec9de3626c71a5396c1",
    "universalRouter": "0x9a082015c919ad0e47861e5db9a1c7070e81a2c7",
    "permit2": "0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768",
    "quoter": "0xbc203d7f83677c7ed3f7acec959963e7f4ecc5c2",
    "kernelMetaFactory": "0xd703aae79538628d27099b8c4f621be4ccd142d5",
    "kernelFactoryV33": "0x2577507b78c2008ff367261cb6285d44ba5ef2e9",
    "kernelImplV33": "0xd6cedde84be40893d153be9d467cd6ad37875b28",
    "ecdsaValidatorV31": "0x845adb2c711129d4f3966735ed98a9f09fc4ce57",
    "callPolicy": "0x9a52283276a0ec8740df50bf01b28a80d880eaf2",
    "timestampPolicy": "0xb9f8f524be6ecd8c945b1b87f9ae5c192fdce20f",
    "ecdsaSigner": "0x6a6f069e2a08c2468e7724ab3250cdbfba14d4ff"
  },
  "assets": {
    "AAPLB": {
      "token": "0x6de69565f250146c67d56be5aa15b6f181fce4d7",
      "pool": "0x223105fdcab05dcde383e9a0c66d302f5440dfa9",
      "oracle": "0x8ae70de4691040e00224b43575f4bbdd7825ecfd",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "156240"
    },
    "AMZNB": {
      "token": "0x2c1d0eb771f8a17b78ea1855c0a896bc5ba8e85a",
      "pool": "0x84dd25c9ce45d6357aaaca19d0763f696ef2c73a",
      "oracle": "0x1ae04179a2f75cd55b8e193753fe5c834ba721eb",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "22890"
    },
    "AVAX": {
      "token": "0x4251ddb21558a783a89982712a19c6a0e13eaa96",
      "pool": "0x2f990657e5f503b38523ea26eda0c14795c3655b",
      "oracle": "0x9b44857843cdfbc75ce084df0bb124e25fdd55bd",
      "feed": "0xa5e212ee4fdcb7d34aae64104e03bf98e4f6abc4",
      "secondary": "0x4fc84efdcfbdcab49ed5bbebf0214ad06b7bcfce",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "9940"
    },
    "BABAB": {
      "token": "0xaa2f20dc2dcdf3fed139e39651af3a889cfb5f8b",
      "pool": "0xac9fc51b3f709894b0e387ab979cca16a1fe3a39",
      "oracle": "0x80ae1a810739e63fdec9082bc13ba7dd76bdf209",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "71750"
    },
    "BTCB": {
      "token": "0x15a4d70ef4400638b5c623997a1a4d0f559e6407",
      "pool": "0xab376db4c5a542e16f511ca74397ac6df98e7a3b",
      "oracle": "0x3720787c31050fab52f4244e4df876869f80bb2b",
      "feed": "0xaa5532696039d5601f12eba07fb2cc1a10314756",
      "secondary": "0xc645e1105c10f9f7da42fdc664736041718f4e69",
      "decimals": 18,
      "poolFee": 500,
      "maxLegUsdt": "3464790"
    },
    "CRCLB": {
      "token": "0xa663434d6f59e3a4fb82b966e6540e0a5d772e70",
      "pool": "0xcc7386ec4ef4672ac6741866b143ee2452c1da2d",
      "oracle": "0x2428591858f4d75c3368a81c9235fd92b33266cc",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "68320"
    },
    "DJTB": {
      "token": "0x98c934259253909461923a25d436ffb0ce53801d",
      "pool": "0x7dbefd415b50e69388d20386dcdb27d823f6ad42",
      "oracle": "0x1f35cd35dedeb2b7627c43df46223ba8288d1bdb",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "910"
    },
    "DOGE": {
      "token": "0xbde73353ce69900f0ffed9cc939894d310939cac",
      "pool": "0x9d21a080aa35aeac5a9787ba6854d4dc52c3bd9e",
      "oracle": "0x7e6edf799b5c0f3bbaa6f5db858a8cdc5eadafdd",
      "feed": "0x1fd6abe4eafe37d2261a629a68dc4171c99e8c94",
      "secondary": "0xc0f94944aa039f88c3c476ee55776b8a538f7081",
      "decimals": 8,
      "poolFee": 10000,
      "maxLegUsdt": "44030"
    },
    "ETH": {
      "token": "0x30fdab8087bcc5bfcab8b8607ded8512d56ea00b",
      "pool": "0x0fe414b83cfd0e9518159e6c1bd6f7ffa9bc71ad",
      "oracle": "0x56970feb76aecf66840dbe7926a48b0e220e9adc",
      "feed": "0xf3f6b4c266625ff43ed97b84a90f6d450ec15396",
      "secondary": "0x70cc178f7b06079cf63ab48dc0083751e81b41d4",
      "decimals": 18,
      "poolFee": 500,
      "maxLegUsdt": "2187360"
    },
    "EWYB": {
      "token": "0x9075fbfe8b7ada95a87ba7691064cc19cdc31250",
      "pool": "0xef486a29de7ee8f689fce6744c5cf88b784bb622",
      "oracle": "0x4bf04b5aaf038b7460ae7da7d630463ad139068a",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "32550"
    },
    "GOOGLB": {
      "token": "0x1588f61dfc020b2f213c0402412d320bfe0ea62b",
      "pool": "0x164316961de969c176a123763232e96000a7c942",
      "oracle": "0x5ac4980d1c5909c3a42eb4ce2d97d0af7f47d9f9",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "113540"
    },
    "HOODB": {
      "token": "0x19ca5fb5cbcacf6ff743ecc313e1cbd317077a01",
      "pool": "0xaa0c54562bd0c5e569ff03bbe15f79bf89d31665",
      "oracle": "0x445326a2a986250063bf1ad6e4b884eca71c1aff",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "6790"
    },
    "INTCB": {
      "token": "0x32cb3ec5e5546a33494bb3c929cbef903ed79e34",
      "pool": "0x90cfbcc6b6e781c42ab1a122d3722f9a5e9bed04",
      "oracle": "0xb8fc61b58e324b34b7647e878c3a6dab0bf332e4",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "107800"
    },
    "METAB": {
      "token": "0x879766bcbb063b408c95422bc7e749dff8fca51e",
      "pool": "0xe55a1963d3360eb2eb51decec7f08026bd415d08",
      "oracle": "0x5cdf727f4688301a7f891e23165a51170fc1d287",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "38570"
    },
    "MRNAB": {
      "token": "0x299a6513333561eb70d0d421343cf0374e19ea08",
      "pool": "0xe9a77b0830abd1f65b068b0d455e7d7596730746",
      "oracle": "0xe9833cb695d6850457bcc6d7bf2072424a396fee",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "10150"
    },
    "MSFTB": {
      "token": "0x85625b081f5c22b77bd93e1064b3be54e797bf77",
      "pool": "0x00e28b75d5a53df93caa735868a434484a7c7107",
      "oracle": "0xf125e34ea136b169a62e115e43f7ac9a4eb806e2",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "44660"
    },
    "MSTRB": {
      "token": "0xe19e5cc9b15f400074b46d5ed4c0ae510800c121",
      "pool": "0xe5e92f584c674ab06f54f13722b3f5c20063338f",
      "oracle": "0xe3ddb22a9df1cfa531e24d73bd966a4920868b4d",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "29750"
    },
    "MUB": {
      "token": "0xf0913c6110227b37a924420814a192a1640b7f06",
      "pool": "0xcaf0dd8463ef4ac8f87f78a45d74785cdcd4f938",
      "oracle": "0xc3c5d7b7999a59f732ccfa5c0663ee29a44fcbdb",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "77980"
    },
    "NFLXB": {
      "token": "0x21d05538b0c0f91615b5088f8789bbcc87b60e8d",
      "pool": "0x1c0dd7796b24e54341c1e077523e00a6ce0a86b2",
      "oracle": "0xe10e36a717f1a89c5e58ca739d8de7994de0e270",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "12180"
    },
    "NOKB": {
      "token": "0x80fd69173d96b3eecdfdda9bbab0be0e5006599c",
      "pool": "0xf203524fdd3a7f187fed1e21435c05c4cbf4005c",
      "oracle": "0x0c3267b522f64896eae1348784e449a1307f9b1a",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "3570"
    },
    "NVDAB": {
      "token": "0x7cca0faff746f534e9fccb3bd957638a62321303",
      "pool": "0xe49f08604f985839e97172844e69dd90b55d85cd",
      "oracle": "0xaded51ea8be1b1a4607ebd3d4105829b226fb195",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "590800"
    },
    "QQQB": {
      "token": "0x6f39d49a580a9004218f36d309a2c5001fa2d3a2",
      "pool": "0xdc7507b07aa1828b2623222e18b3f46cbc610630",
      "oracle": "0x06c06c92595f5af67940f6cd24a7ec49a38dfa38",
      "decimals": 18,
      "poolFee": 500,
      "maxLegUsdt": "791560"
    },
    "SGOVon": {
      "token": "0x088a76151f83d797fba02ce80caa18cd1b886e6b",
      "pool": "0x04f5a1a691eaacfe393d961b0984f984b92f6936",
      "oracle": "0x12850c1cb5453f89cb8b3d1b6185aa539a23d5b6",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "279790"
    },
    "SKHYB": {
      "token": "0xdf214e855d81077973f166d894653c33faedfe25",
      "pool": "0xd0e793f44fbb4e70e446d2f626502645e403d57e",
      "oracle": "0xcbe59f888636c4841c7ec6110c5c986bf5cf5e3e",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "297430"
    },
    "SNDKB": {
      "token": "0x2eac951a0fed4d2fcf2b60797a8aa93b87a8c73a",
      "pool": "0x02e2fda0c380c3a6a4fddcca0703d9e569062a8d",
      "oracle": "0xaede99eb7c59dfecb4348b8f0a790d7e1ed99d8e",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "20230"
    },
    "SOL": {
      "token": "0x938c7750a8752f5e5e1bfa533c350d1a2dc7faf0",
      "pool": "0xf83ebc116db895848262d136fd9d88fe47436026",
      "oracle": "0xfabe117e9ac31ea906946028305da81900dfaad7",
      "feed": "0xe458359506f26c40b053cf91a0a827973b4205e8",
      "secondary": "0x45240c19ac808d714a6faa00c67a99364fc566ee",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "115500"
    },
    "SPCXB": {
      "token": "0x6069d85fff97f7f1b7694341a4d81d051bded136",
      "pool": "0xc9f1efac6e42ccd63f41020a2279894d68a01a17",
      "oracle": "0xdec5696046fb804b10dcd06d9d5b3f4c6f3f2eaf",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "695240"
    },
    "SPYB": {
      "token": "0x6e43fb73434a81ac95625256f1a704431a50fba2",
      "pool": "0x3f2302592e4c3ba220425682db90017fbe46442a",
      "oracle": "0xc62d9c914f1bb66c9c29ef6e3553d455fd9b0afa",
      "decimals": 18,
      "poolFee": 100,
      "maxLegUsdt": "110390"
    },
    "TLTon": {
      "token": "0x6a0cd0d440a946edfee9d4a0c0bd362c2a4225b5",
      "pool": "0xef7efd2f1126126b7ee2c8206f902a97d881520c",
      "oracle": "0xb516dc6980a77976641d3e49a24ce4d24bd822a4",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "1400000"
    },
    "TRX": {
      "token": "0x69103b2b48a5ab51bce96d2d14169f6b612cd4e2",
      "pool": "0x5485be2e3ef3a134abaab141f68a662bce27146c",
      "oracle": "0x03b18eca2c5342d90e0bff32d49130a7267b4a25",
      "feed": "0xd8167f60eccba3629947a4e33c6a9d3e26df82bf",
      "secondary": "0xc1e267c2a01da856f46a1e336fc1b9470ea91a7a",
      "decimals": 6,
      "poolFee": 2500,
      "maxLegUsdt": "35280"
    },
    "TSLAB": {
      "token": "0x7c4d269987a85d30a8e7cd46e8eaff2c739a44d2",
      "pool": "0x96ba1bb32f79a2f3c8b7d9cb51ae5e902d71825e",
      "oracle": "0xba795e3472a5b2f9b48f32d96f91b91b3c0a574a",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "294490"
    },
    "TSMB": {
      "token": "0x414450e39bfc5faec290a99b23c3cd8f5b2591af",
      "pool": "0xc34ea1b3b724e9b8a3fd1fb6c3e3cc002b666a5a",
      "oracle": "0x3c0ba19a19a99493de95ba08a551b6a616afca60",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "10570"
    },
    "WBNB": {
      "token": "0x8ca7ef628e212e40ab9ce65338a4a3ddbc99b9ac",
      "pool": "0xbcc0f7454679510bec5dd82d7df56096827bcc4b",
      "oracle": "0xde87600752f66451a14bd0cb491adcf909947dea",
      "feed": "0x0c3cddef1270540d6366d9ce3fea8c643d0ef1bf",
      "secondary": "0xe9baace3045ed540ea3df30792cb19337f07be41",
      "decimals": 18,
      "poolFee": 500,
      "maxLegUsdt": "1398040"
    },
    "XAUt": {
      "token": "0xfdaea502817d7ce35ca3a89dac5b0f53556e3b9e",
      "pool": "0x9a36f0903da57281c1ebc76aeec26137889a8ab7",
      "oracle": "0x4d8b09a4174127c662dc9e07294a9efcd3539dbf",
      "decimals": 6,
      "poolFee": 500,
      "maxLegUsdt": "232960"
    },
    "XRP": {
      "token": "0xb9e6e6a000c21039867724c65313373b90e8f3dd",
      "pool": "0x74641c48d109535a8cc5ca159ee735de35b0754c",
      "oracle": "0xf6dd934032a975bf3472a8c86224e392ec0610fd",
      "feed": "0x4ffef9a114b49ac870037b1b856ab7c3dc028272",
      "secondary": "0x54eb29d4698e2123be7e391eac3d567549d2a57a",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "115990"
    },
    "USDC": {
      "token": "0x30cdbed776c5d483f655f2ce614860f6e7666218",
      "pool": "0x3e7cb63d051e279e1d45be87aff927f8a08a9ec4",
      "oracle": "0x34000ab81d077011ed0d054c030b5dc28eb4af48",
      "feed": "0x6e99c8a8de866bac6a5c68de0abc20621f1b4968",
      "secondary": "0xe882cc609c6f5a9afdc1b48481b79a8d534f0cc4",
      "decimals": 18,
      "poolFee": 100,
      "maxLegUsdt": "17852520"
    },
    "DAI": {
      "token": "0x3bcfb731e707278239b9c2483d6bca3bbf284c6f",
      "pool": "0x96f4884f33cd0c77cdd82c8934ee3da680f1deca",
      "oracle": "0x3255c04502152273c84634a410d6fe4c363b901d",
      "feed": "0x8c46d34d4c385ad8b45abf4c493c5790b21b6478",
      "secondary": "0x54cf5e7adb1554bf9140448bfe6f2b3bf967417f",
      "decimals": 18,
      "poolFee": 100,
      "maxLegUsdt": "19390"
    },
    "LTC": {
      "token": "0x7874511188b2ea81f2ba4e177a8eced23e5a28b0",
      "pool": "0x7b2e7c8287a7b7dc3757538f8b7bb6bf8a704647",
      "oracle": "0x756a7242c548811bd05f97416d5755a420bdcf85",
      "feed": "0x750f3415122ae9cf34e6cab35acef883a37b0113",
      "secondary": "0x9f45ea3957e024085c6b61b56912d96775af16f3",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "42000"
    },
    "ABBVon": {
      "token": "0x9b76b0cd3eb101e4c7e7d9a80397648ff5ba985b",
      "pool": "0x9bb843b64d6a49e2e9eee9edd38b5ccf4f40094d",
      "oracle": "0x5005dc4856ae99cdc9819ec32ab148b707674807",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "ALABB": {
      "token": "0x1e267ead867a6eb5e8beb2e66f91fd20eed426d5",
      "pool": "0x97573f650a95164bc0adc100cb81dcd7583fbb0f",
      "oracle": "0x43594936619b153638dd6ef6b8b1d8a9f8a2b0de",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "AMATB": {
      "token": "0x255cfdd632600a289a181caab4511c30a10f7949",
      "pool": "0x9b8eaed5f4a68b3669d1c80f7680c7dccf7ea521",
      "oracle": "0x0e54f641193e8361cee5bcbf6be90b70b11ecde1",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "AMDB": {
      "token": "0xa887f513a46aefa98bf42ae28b74ff2c6ca70fc7",
      "pool": "0x24ed5bc652ae7c7b0e179656adbf7c004e7c10da",
      "oracle": "0x7162606bd02247b0ba756519a3c0b3408df17c04",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "APHon": {
      "token": "0x0ad9f1644333a3dc950901c793998bb18663e4d8",
      "pool": "0x74071947885acdb42adec69defb123f48adc86ef",
      "oracle": "0xda59c1da4cf36161d42998565cf5b98f98aa9a43",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "APLDon": {
      "token": "0xa5611547b984a7deef1e4fc0e8e0d8b0798e3300",
      "pool": "0x0f5c638272749bd81ac52c862f327577d819ce7a",
      "oracle": "0x852ca75e7999e41bbf6c210829acef19fa8cdc83",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "AVGOB": {
      "token": "0x1b686f1268f05dfe9f2effe2117f2e7807d59cf2",
      "pool": "0xd16a76dc1acd5247d29f7dcb0e48fe6034344b19",
      "oracle": "0x638d9bdedf90430d634b657f78e5482421de5605",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "AXPon": {
      "token": "0x9b3fb69e3998e371399128f80fc9ff941d50b55f",
      "pool": "0x8121188cd3901960b733a4dddc1c151a93d92457",
      "oracle": "0x988a27dcdaac15b30e6f6b88fe69e44a0c6fd555",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "BEB": {
      "token": "0x4aa1d4149724e6cc5003a12faca47eef48f8cc40",
      "pool": "0xe967c310a0458dcad4d664121e2d0796acd30ead",
      "oracle": "0x4506100935d738fff1815e43a420afbf0d87314c",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "BLKon": {
      "token": "0x70de7713d83eb54ea02749a57b4c510b087aba29",
      "pool": "0x7b6450fd0ada5dd791ff9f4c95e23cc6ae8d9f2a",
      "oracle": "0x62916a8e073427b85fd80369daccfb70a6d41c7b",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "CBRSB": {
      "token": "0x026275af378d498fb7eea6d6cb7539393a9e0c6c",
      "pool": "0xc8eb810a22736a2112790b51c5fe5d8167385ca6",
      "oracle": "0x057d82ec5afdf3409fd07020680fc708a5b645e7",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "CEGon": {
      "token": "0x1a6a9d761c14f5f5722de0f258a8c1ede5b1c4e7",
      "pool": "0x7a62139416e5f1d3483834b68f937762e9c3edca",
      "oracle": "0x521fd925c1d9ed7fec7631045ac742af19c93838",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "CIENon": {
      "token": "0x319fe02ddfe1bb894825b0813712f8a71e3a4368",
      "pool": "0x01e09acb3552aa13af899e62d10b1c1633eade1e",
      "oracle": "0x670472d662e8189c128a55af80d8d55f4d3c3225",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "COHRB": {
      "token": "0xab415c7b7eaa29f5870ae4e88ce6518b4566356f",
      "pool": "0x9c3a1fa0f319ee9810b6d625bf093d487772efc9",
      "oracle": "0x3558db7ec5743c8747617463732baa2e43d868c3",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "CORZon": {
      "token": "0x015ebadf7fcad8d86b32cdb8ce29844edda95b70",
      "pool": "0x83638b35505648779280e6634da56fda608df2f8",
      "oracle": "0xb3e82c958fcb42f002369838e2487c551de6b0e8",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "CRDOB": {
      "token": "0xed752a446d117a081a304b670ccc3239843918e3",
      "pool": "0x3931df2c0d1266c826367c26c53fca216239300c",
      "oracle": "0xc7314d7516f89bac6780a67310c55c135c68e572",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "CRMB": {
      "token": "0xe96ddbd298c460f1a3ba0c0c043093f62c8e875a",
      "pool": "0xdf932a7a74853210e49904ace5dd468ceafb0df7",
      "oracle": "0xa42bbe6c6e6495463ff138d84eb6a2afc528f84f",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "CRWVB": {
      "token": "0x1812c38838cfa3a2d65bbad032c2b37b6ecfb737",
      "pool": "0xc7bcdb1bae5e332b708b0c6fb6ddf8c39ca1eed9",
      "oracle": "0x1e52eb15b8a99d3a74f0f6ab414050358004f53e",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "CVXon": {
      "token": "0xdea3e81b35c4f550b3e1ae824c139be7a378e4c0",
      "pool": "0xf441ff81b85b4e2346599c9d1a9737c35f7bac6e",
      "oracle": "0xdd50ff3e416a5aa682dd41f0641f830bc64c6892",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "GEVB": {
      "token": "0x2e4b59f91ec2ee494f7daa209201f8f27f67bbff",
      "pool": "0xb6c312557a02d14589e6f911b1d132897391d258",
      "oracle": "0x650050a1e7505929377f426b9cb466fcace1ef70",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "GLDon": {
      "token": "0x1e018aa559d3b947ab37646327713d07fad50912",
      "pool": "0x3b900ce213460dcf1656fd163185d8a7d86c7c30",
      "oracle": "0x70f483706ab460ec35b8941ac2dca1913ea15b7b",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "GOOGon": {
      "token": "0x0fabfd379349c0ea8a4606c4658497e61ee14760",
      "pool": "0xf47b10e0810fff64e49241c5028d4d7523471dc1",
      "oracle": "0x5ded651bb2fb218899e78e71bd760f8c91b228b3",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "GPROB": {
      "token": "0x146a3b6d848119158fb9add261ecc1f3554b5b89",
      "pool": "0xc99004275a561b5e52c3366b840b96e2d05b3e2a",
      "oracle": "0xb0e552926954e2f399346fdf9c85570548ff5c33",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "IEFon": {
      "token": "0xbb261723a59f85cec235c77ca3c8b2b5f60cd4aa",
      "pool": "0xa326ecfc89bf05bbab6d70606322960877cf7ca4",
      "oracle": "0x19f44e0199300a069baa37f1e83d980648ed79c1",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "IRENB": {
      "token": "0xaf83b816ac2df259cce113be85c9072f6641b34b",
      "pool": "0xd5b419ad5dea375335be0b3ce0f0c2de4b6e0742",
      "oracle": "0x194818bd9157c2ea01e93f78627e989a77bdfc40",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "IVVon": {
      "token": "0x616494e6043dc5c362878db6c4c126dd586abe28",
      "pool": "0xbd279ee78fc20b55b5dca2f9d872783b5b27e8fb",
      "oracle": "0x3d53e27b2826e78fdeb2e3f3515cb456c5da07de",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "KOon": {
      "token": "0x02d2700fe3f1e28954ce9fa41966d1c944d72b52",
      "pool": "0x5bffa3203abb2e250ba1b22ccab015e75f856b33",
      "oracle": "0xf9b37e7cc8a98a5d928219e316a6f34343f5a39a",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "LLYB": {
      "token": "0x59c67ff7f24a0c2325c6372f0ef2809cf5cb546f",
      "pool": "0x69f493dfd083c8d34c8e86935eac9a32c2153445",
      "oracle": "0x55db4e91ea516959f1388c9269d689e8c55d3357",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "MAon": {
      "token": "0x09ba441bfca50ea559f0766b7e5b7baead3c2c8a",
      "pool": "0xfb71c4ba15515a59494bb9d9e7c5efab349b7cce",
      "oracle": "0x5ebf55935d67fc51f466ad7dfb140739aeb85efc",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "NBISB": {
      "token": "0xd8ef174bb435d31f89468544c7f9f1e4b19c298c",
      "pool": "0x4deb25731c0b8d976e84b4089469b4a838effa05",
      "oracle": "0x17360fdc7657808480477b0cb5936e24d740c5ea",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "NEMon": {
      "token": "0xfac7a975d0bf254c438d9d7c4e2754977eb836d6",
      "pool": "0xc96768ed4643f6f6ccd808d7d215efcb37b46b72",
      "oracle": "0xa9f5f436858ebaf2911ccc64f232fb9ea992adde",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "ORCLB": {
      "token": "0x5ec68aba17671d211c0d79d070c9acc193889955",
      "pool": "0xc870ba30ebc6d1ec7225bab6c9a6dba093a53d70",
      "oracle": "0x5f1d54aeeacc4488768b3f8f6ad314d7bca296a9",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "PANWon": {
      "token": "0x9aedd320474b527234e0fcf95594112c3f781c91",
      "pool": "0xcebcc2ad89c811a39dfe3529768a2f7ba83f1bd0",
      "oracle": "0x05c0197239f36f6c20b51f3e53d1bd46a5c09ac5",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "PYPLB": {
      "token": "0x6e417454adfcb7d0ca0eba7b4b5318da0f53ab81",
      "pool": "0x4b7baf58f3972f2acba2b259204b58c9b50b8881",
      "oracle": "0x5d4007ac0e6a479052979799f352ad8be910beab",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "SHAZB": {
      "token": "0x7022ea5bca8737d3245430bd2db49ed7711ff01a",
      "pool": "0xd489f1abdc6c0a73251521a3b80fd39467f83ffa",
      "oracle": "0x35b39cd2e9a0b8a062d9a96c161013e6f6fc72e5",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "STXB": {
      "token": "0x1b70a09a974f269bd86632cc81c1c12d775590db",
      "pool": "0x896c6e70aebe7257e523d717dc9a87961043d757",
      "oracle": "0xa6f0b54633a972d1d901baa526584eb67bd83cd7",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "UBERon": {
      "token": "0x7a6e6f404dfe67e4f064a173ab52d838baa9498a",
      "pool": "0x1ca305056a0819e2d09458c173e5a7553be7f49c",
      "oracle": "0xc72ee1066059f3a4e7cc47008033b57f7b455bf2",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "VRTon": {
      "token": "0x88aa53ed64f8b06f7c4ba7cc6c87869fd5b646a4",
      "pool": "0xe158d97784b46ff34bd24c2c690682e84606069e",
      "oracle": "0x2b0dce43042e3ec199633fddcdc5802914d20961",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "VSTB": {
      "token": "0xf697267d420faf19f10059d015eacb8fd76799f6",
      "pool": "0x6f1e432faf2e59d42ce4178fe5e443b7111dc729",
      "oracle": "0x9fbc0f5c01d569308e34beca6fb5b69c99e16dde",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "Von": {
      "token": "0xaf518cac016d5c16dab03cca329e308db7391e1e",
      "pool": "0xb4ffcae4eabae80e44dd657df51433464f6e1a0a",
      "oracle": "0xe3289b9287c19ab4525fae7f97c3e784782eb7a4",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "ADA": {
      "token": "0x286d41ea9845a879ac76494650ff59b9d69cb164",
      "pool": "0x2d79732e662209114a06fa2ff7be24f555a06b09",
      "oracle": "0x328694fd3483287a71de0d473288e5fefed25c48",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "LINK": {
      "token": "0x456fac6c36fbc8d1cb4245d3b80a807a3e2a5d1d",
      "pool": "0xcff470f26ea455536e758da2b268842f201416a8",
      "oracle": "0xdc7a72dbe4a56be0f92459ae9a1f34e990f317b7",
      "decimals": 18,
      "poolFee": 10000,
      "maxLegUsdt": "5000"
    },
    "BCH": {
      "token": "0xcc4f64d93399e66a5a0fbf25a015da02e1364208",
      "pool": "0x6b713adc102486c036dc239e8fe1eb97f578fc9c",
      "oracle": "0x64b6efefa9deb4b6f6b85eb793ae203cdc43041e",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "NEAR": {
      "token": "0xa3c6f5b3196cfb745c3be1bc914c83f064121565",
      "pool": "0xb3c9173e9299f7ee71bab709f163a56d3b869f64",
      "oracle": "0xec411d3be266f0a55cb82e84d01dcf9a6d8bb855",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "UNI": {
      "token": "0x1224c02ba57a0ccdf994c96f3e0f2400ca5559a2",
      "pool": "0x92acdf9ce8d39e8c78fa1f668a847850b3eadb5e",
      "oracle": "0x03d5d281babba781e39bf43daa6b9b2384b47b98",
      "decimals": 18,
      "poolFee": 10000,
      "maxLegUsdt": "5000"
    },
    "ZEC": {
      "token": "0x92e51e050c6232528d4eca5b64a176b5a9e12bed",
      "pool": "0x4613676a9ed1790ba4bb5d6fce9c5b99b4b480a9",
      "oracle": "0xbb51f2a47bc9c27a4c10df8bbf13feaecdf58300",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "TONCOIN": {
      "token": "0x5f8b9da554e35ca80b931280c9c5fd9a54c923f0",
      "pool": "0x8d39c85a542d3d05b053ed4a56761beed67fc5aa",
      "oracle": "0xd652dfac675ed271543e4c4a8742e3da5462ae7a",
      "decimals": 9,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "DOT": {
      "token": "0xc9341a66c56a60cfbef718402fde69b59d2fc014",
      "pool": "0x5827671cb4251034a38eb0f28ab4114d13d5b8a3",
      "oracle": "0xceb440d67fc16c79c1bc86ba7b13b0b6abcd94de",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "SHIB": {
      "token": "0xdb91a5977d35b0cc32e84de2f974d86582941c6e",
      "pool": "0x948452f61d487ff8945d9fa07a2d8aade1fdcf69",
      "oracle": "0x812bc2892777169dabc61eff66f9f1e243c8a507",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "PEPE": {
      "token": "0xed6d9c53d6369ccfbff8e2cae264a298ad3921b8",
      "pool": "0xbdea3a5c76f040737854516a12c4e4984109fc55",
      "oracle": "0xd41249663fd410dc3d0de4d8ae386e4576f96bc3",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "AAVE": {
      "token": "0xc11dbf7979f0fa2a40fdff8c8f9c02971e3460e0",
      "pool": "0x76738a335364a7be2669a33c58521a3e43af0917",
      "oracle": "0xef817c46726729b7e9950c5ce42e2e6f36f6e10e",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "Cake": {
      "token": "0x163d2a0119ec959019ad43662eca66b70dc7d81a",
      "pool": "0x1b6312f1146ba2d9fdf26c8d223ec3a2356d7de0",
      "oracle": "0x3b38eb9819aa6babeb3985dccd64fe893453ae0c",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "FIL": {
      "token": "0x5adfdb29bfa979a4a91ea01b849373005d00ccd6",
      "pool": "0x77bee8b4cf9e754c53d7d46a238af639c6c7d207",
      "oracle": "0x948d56a2b5c6386f7fea787eaae4199ca46431d8",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    },
    "ATOM": {
      "token": "0x0a289c717912a1ab7dc49d278b5e4afff9f5042a",
      "pool": "0x291c1357b3b027143cb33b566a5ff472e6260bf7",
      "oracle": "0xd1263b7a74a55df4b8c33422bc818593da2c0b32",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "5000"
    }
  }
} as const;

export function configuredChainId(): number {
  const id = Number(process.env.CHAIN_ID?.trim() || '56');
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid CHAIN_ID');
  return id;
}

export function testnetAssets() {
  return [
    { address: TESTNET_97.contracts.usdt, symbol: 'USDT', decimals: 18, is_numeraire: true, usdt_pool: null, max_leg_usdt: null },
    ...Object.entries(TESTNET_97.assets).map(([symbol, asset]) => ({ address: asset.token, symbol, decimals: asset.decimals,
      is_numeraire: false, usdt_pool: asset.pool, max_leg_usdt: asset.maxLegUsdt })),
  ];
}

/** Reject explicit foreign addresses; empty settings resolve to the pinned deployment. */
export function profileAddress(chainId: number, name: string, raw: Address | null): Address | null {
  if (chainId !== 97) return raw;
  const addresses: Record<string, Address> = {
    REGISTRY_ADDRESS: TESTNET_97.contracts.registry, EXECUTOR_ADDRESS: TESTNET_97.contracts.executor,
    PAYMASTER_ADDRESS: TESTNET_97.contracts.paymaster, PAYMASTER_MOCK_USDT_ADDRESS: TESTNET_97.contracts.usdt,
  };
  const expected = addresses[name];
  if (expected === undefined) throw new Error('Unknown profile address setting');
  if (raw !== null && raw.toLowerCase() !== expected) throw new Error(name + ' must match chain 97 profile');
  return expected;
}
