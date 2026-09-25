/* ============================================================
   Dalal — data layer
   Illustrative demo dataset for the Indian market (NSE).
   5 years of daily closes (Sep 2021 → Sep 2026), generated
   deterministically with a seeded PRNG and anchored to
   realistic price paths. NOT live market data.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- seeded RNG ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------- trading calendar: weekdays Sep 20 2021 → Sep 18 2026 ---------- */
  function buildDates() {
    const out = [];
    const d = new Date(Date.UTC(2021, 8, 20));
    const end = new Date(Date.UTC(2026, 8, 18));
    while (d <= end) {
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }
  const DATES = buildDates();
  const N = DATES.length;

  /* ---------- price path generator (piecewise log-linear + smooth noise) ---------- */
  function genSeries(seed, anchors, vol) {
    const rng = mulberry32(seed);
    const raw = new Array(N);
    for (let i = 0; i < N; i++) raw[i] = gauss(rng);
    // smooth the noise so it looks like price action, not static
    const sm = new Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 5); j <= Math.min(N - 1, i + 5); j++) { s += raw[j]; c++; }
      sm[i] = s / c;
    }
    const pts = anchors.map(a => [a[0], Math.log(a[1])]);
    const out = new Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      let base;
      if (t <= pts[0][0]) base = pts[0][1];
      else if (t >= pts[pts.length - 1][0]) base = pts[pts.length - 1][1];
      else {
        let k = 0;
        while (k < pts.length - 2 && t > pts[k + 1][0]) k++;
        const [t0, v0] = pts[k], [t1, v1] = pts[k + 1];
        base = v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
      }
      out[i] = Math.round(Math.exp(base + sm[i] * vol) * 100) / 100;
    }
    return out;
  }
  function genVolume(seed, base) {
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const out = new Array(N);
    let spike = 1;
    for (let i = 0; i < N; i++) {
      if (rng() < 0.02) spike = 1.8 + rng() * 1.6;
      spike = 1 + (spike - 1) * 0.92;
      out[i] = Math.round(base * (0.72 + rng() * 0.56) * spike);
    }
    return out;
  }

  /* ============================================================
     INDICES
     ============================================================ */
  const INDICES = [
    {
      sym: "NIFTY 50", name: "Nifty 50", full: "NSE Benchmark · 50 companies",
      color: "#0071e3",
      anchors: [[0, 17600], [0.28, 15350], [0.55, 21800], [0.80, 23400], [1, 25940]],
      vol: 0.011, seed: 101
    },
    {
      sym: "SENSEX", name: "BSE Sensex", full: "BSE Benchmark · 30 companies",
      color: "#5856d6",
      anchors: [[0, 59600], [0.28, 52100], [0.55, 72800], [0.80, 78200], [1, 84850]],
      vol: 0.011, seed: 202
    },
    {
      sym: "BANKNIFTY", name: "Nifty Bank", full: "Banking benchmark · 12 banks",
      color: "#30d158",
      anchors: [[0, 37800], [0.30, 32200], [0.55, 48900], [0.82, 52600], [1, 58320]],
      vol: 0.015, seed: 303
    },
    {
      sym: "NIFTY IT", name: "Nifty IT", full: "Technology benchmark · 10 companies",
      color: "#ff9f0a",
      anchors: [[0, 37300], [0.35, 28900], [0.55, 33500], [0.78, 42100], [1, 38560]],
      vol: 0.017, seed: 404
    }
  ];

  /* ============================================================
     STOCKS
     ============================================================ */
  /* ============================================================
     UNIVERSE — wide NSE list (symbol, name, sector).
     Flagship stocks in STOCKS have hand-curated data; every other
     symbol here gets deterministic illustrative fundamentals and
     history, and LIVE prices when server.py is running.
     ============================================================ */
  const UNIVERSE_META = [
    /* Financial Services */
    ["KOTAKBANK", "Kotak Mahindra Bank", "Financial Services"],
    ["AXISBANK", "Axis Bank", "Financial Services"],
    ["INDUSINDBK", "IndusInd Bank", "Financial Services"],
    ["BANDHANBNK", "Bandhan Bank", "Financial Services"],
    ["FEDERALBNK", "Federal Bank", "Financial Services"],
    ["IDFCFIRSTB", "IDFC First Bank", "Financial Services"],
    ["YESBANK", "Yes Bank", "Financial Services"],
    ["PNB", "Punjab National Bank", "Financial Services"],
    ["BANKBARODA", "Bank of Baroda", "Financial Services"],
    ["CANBK", "Canara Bank", "Financial Services"],
    ["UNIONBANK", "Union Bank of India", "Financial Services"],
    ["INDIANB", "Indian Bank", "Financial Services"],
    ["IOB", "Indian Overseas Bank", "Financial Services"],
    ["UCOBANK", "UCO Bank", "Financial Services"],
    ["CENTRALBK", "Central Bank of India", "Financial Services"],
    ["MAHABANK", "Bank of Maharashtra", "Financial Services"],
    ["AUBANK", "AU Small Finance Bank", "Financial Services"],
    ["RBLBANK", "RBL Bank", "Financial Services"],
    ["JKBANK", "Jammu & Kashmir Bank", "Financial Services"],
    ["KARURVYSYA", "Karur Vysya Bank", "Financial Services"],
    ["CSBBANK", "CSB Bank", "Financial Services"],
    ["BAJFINANCE", "Bajaj Finance", "Financial Services"],
    ["BAJAJFINSV", "Bajaj Finserv", "Financial Services"],
    ["SHRIRAMFIN", "Shriram Finance", "Financial Services"],
    ["CHOLAFIN", "Cholamandalam Investment", "Financial Services"],
    ["MUTHOOTFIN", "Muthoot Finance", "Financial Services"],
    ["MANAPPURAM", "Manappuram Finance", "Financial Services"],
    ["LICHSGFIN", "LIC Housing Finance", "Financial Services"],
    ["PFC", "Power Finance Corporation", "Financial Services"],
    ["RECLTD", "REC Limited", "Financial Services"],
    ["IRFC", "Indian Railway Finance Corp", "Financial Services"],
    ["HUDCO", "Housing & Urban Development Corp", "Financial Services"],
    ["LTF", "L&T Finance", "Financial Services"],
    ["ABCAPITAL", "Aditya Birla Capital", "Financial Services"],
    ["SBILIFE", "SBI Life Insurance", "Financial Services"],
    ["HDFCLIFE", "HDFC Life Insurance", "Financial Services"],
    ["ICICIPRULI", "ICICI Prudential Life", "Financial Services"],
    ["SBICARD", "SBI Cards & Payment", "Financial Services"],
    ["PAYTM", "One97 Communications (Paytm)", "Financial Services"],
    ["POLICYBZR", "PB Fintech (Policybazaar)", "Financial Services"],
    ["BSE", "BSE Limited", "Financial Services"],
    ["MCX", "Multi Commodity Exchange", "Financial Services"],
    ["CDSL", "Central Depository Services", "Financial Services"],
    ["CAMS", "Computer Age Management", "Financial Services"],
    ["ANGELONE", "Angel One", "Financial Services"],
    ["MOTILALOFS", "Motilal Oswal Financial", "Financial Services"],
    /* Information Technology */
    ["WIPRO", "Wipro", "Information Technology"],
    ["HCLTECH", "HCL Technologies", "Information Technology"],
    ["TECHM", "Tech Mahindra", "Information Technology"],
    ["LTIM", "LTIMindtree", "Information Technology"],
    ["PERSISTENT", "Persistent Systems", "Information Technology"],
    ["MPHASIS", "Mphasis", "Information Technology"],
    ["COFORGE", "Coforge", "Information Technology"],
    ["KPITTECH", "KPIT Technologies", "Information Technology"],
    ["TATAELXSI", "Tata Elxsi", "Information Technology"],
    ["OFSS", "Oracle Financial Services", "Information Technology"],
    ["CYIENT", "Cyient", "Information Technology"],
    ["ZENSARTECH", "Zensar Technologies", "Information Technology"],
    ["SONATSOFTW", "Sonata Software", "Information Technology"],
    ["MASTEK", "Mastek", "Information Technology"],
    ["NEWGEN", "Newgen Software", "Information Technology"],
    /* Oil Gas & Consumable Fuels */
    ["ONGC", "Oil & Natural Gas Corp", "Oil Gas & Consumable Fuels"],
    ["IOC", "Indian Oil Corporation", "Oil Gas & Consumable Fuels"],
    ["BPCL", "Bharat Petroleum", "Oil Gas & Consumable Fuels"],
    ["HPCL", "Hindustan Petroleum", "Oil Gas & Consumable Fuels"],
    ["GAIL", "GAIL India", "Oil Gas & Consumable Fuels"],
    ["PETRONET", "Petronet LNG", "Oil Gas & Consumable Fuels"],
    ["OIL", "Oil India", "Oil Gas & Consumable Fuels"],
    ["MRPL", "Mangalore Refinery", "Oil Gas & Consumable Fuels"],
    ["CHENNPETRO", "Chennai Petroleum", "Oil Gas & Consumable Fuels"],
    ["ATGL", "Adani Total Gas", "Oil Gas & Consumable Fuels"],
    ["IGL", "Indraprastha Gas", "Oil Gas & Consumable Fuels"],
    ["MGL", "Mahanagar Gas", "Oil Gas & Consumable Fuels"],
    ["GSPL", "Gujarat State Petronet", "Oil Gas & Consumable Fuels"],
    /* Power */
    ["NTPC", "NTPC Limited", "Power"],
    ["POWERGRID", "Power Grid Corporation", "Power"],
    ["TATAPOWER", "Tata Power", "Power"],
    ["ADANIPOWER", "Adani Power", "Power"],
    ["ADANIGREEN", "Adani Green Energy", "Power"],
    ["ADANIENSOL", "Adani Energy Solutions", "Power"],
    ["JSWENERGY", "JSW Energy", "Power"],
    ["NHPC", "NHPC Limited", "Power"],
    ["SJVN", "SJVN Limited", "Power"],
    ["TORNTPOWER", "Torrent Power", "Power"],
    ["CESC", "CESC Limited", "Power"],
    ["SUZLON", "Suzlon Energy", "Power"],
    /* Automobile */
    ["MARUTI", "Maruti Suzuki", "Automobile"],
    ["M&M", "Mahindra & Mahindra", "Automobile"],
    ["BAJAJ-AUTO", "Bajaj Auto", "Automobile"],
    ["HEROMOTOCO", "Hero MotoCorp", "Automobile"],
    ["EICHERMOT", "Eicher Motors", "Automobile"],
    ["TVSMOTOR", "TVS Motor Company", "Automobile"],
    ["ASHOKLEY", "Ashok Leyland", "Automobile"],
    ["BOSCHLTD", "Bosch Limited", "Automobile"],
    ["MOTHERSON", "Samvardhana Motherson", "Automobile"],
    ["BALKRISIND", "Balkrishna Industries", "Automobile"],
    ["MRF", "MRF Limited", "Automobile"],
    ["APOLLOTYRE", "Apollo Tyres", "Automobile"],
    ["CEATLTD", "CEAT Limited", "Automobile"],
    ["EXIDEIND", "Exide Industries", "Automobile"],
    ["SONACOMS", "Sona BLW Precision", "Automobile"],
    ["UNOMINDA", "Uno Minda", "Automobile"],
    ["ENDURANCE", "Endurance Technologies", "Automobile"],
    ["BHARATFORG", "Bharat Forge", "Automobile"],
    ["ESCORTS", "Escorts Kubota", "Automobile"],
    /* Fast Moving Consumer Goods */
    ["NESTLEIND", "Nestle India", "Fast Moving Consumer Goods"],
    ["BRITANNIA", "Britannia Industries", "Fast Moving Consumer Goods"],
    ["DABUR", "Dabur India", "Fast Moving Consumer Goods"],
    ["MARICO", "Marico Limited", "Fast Moving Consumer Goods"],
    ["GODREJCP", "Godrej Consumer Products", "Fast Moving Consumer Goods"],
    ["COLPAL", "Colgate-Palmolive India", "Fast Moving Consumer Goods"],
    ["EMAMILTD", "Emami Limited", "Fast Moving Consumer Goods"],
    ["TATACONSUM", "Tata Consumer Products", "Fast Moving Consumer Goods"],
    ["VBL", "Varun Beverages", "Fast Moving Consumer Goods"],
    ["RADICO", "Radico Khaitan", "Fast Moving Consumer Goods"],
    ["PATANJALI", "Patanjali Foods", "Fast Moving Consumer Goods"],
    ["PAGEIND", "Page Industries", "Fast Moving Consumer Goods"],
    /* Consumer Services */
    ["DMART", "Avenue Supermarts (DMart)", "Consumer Services"],
    ["TRENT", "Trent Limited", "Consumer Services"],
    ["NYKAA", "FSN E-Commerce (Nykaa)", "Consumer Services"],
    ["JUBLFOODD", "Jubilant FoodWorks", "Consumer Services"],
    ["DEVYANI", "Devyani International", "Consumer Services"],
    ["WESTLIFE", "Westlife Foodworld", "Consumer Services"],
    ["IRCTC", "Indian Railway Catering & Tourism", "Consumer Services"],
    ["PVRINOX", "PVR INOX", "Consumer Services"],
    ["SAREGAMA", "Saregama India", "Consumer Services"],
    ["NAZARA", "Nazara Technologies", "Consumer Services"],
    ["ETERNAL", "Eternal (Zomato)", "Consumer Services"],
    /* Consumer Durables */
    ["TITAN", "Titan Company", "Consumer Durables"],
    ["HAVELLS", "Havells India", "Consumer Durables"],
    ["VOLTAS", "Voltas Limited", "Consumer Durables"],
    ["BLUESTARCO", "Blue Star Limited", "Consumer Durables"],
    ["CROMPTON", "Crompton Greaves Consumer", "Consumer Durables"],
    ["WHIRLPOOL", "Whirlpool of India", "Consumer Durables"],
    ["DIXON", "Dixon Technologies", "Consumer Durables"],
    /* Healthcare */
    ["SUNPHARMA", "Sun Pharmaceutical", "Healthcare"],
    ["DRREDDY", "Dr Reddys Laboratories", "Healthcare"],
    ["CIPLA", "Cipla Limited", "Healthcare"],
    ["DIVISLAB", "Divis Laboratories", "Healthcare"],
    ["LUPIN", "Lupin Limited", "Healthcare"],
    ["AUROPHARMA", "Aurobindo Pharma", "Healthcare"],
    ["TORNTPHARM", "Torrent Pharmaceuticals", "Healthcare"],
    ["ZYDUSLIFE", "Zydus Lifesciences", "Healthcare"],
    ["MANKIND", "Mankind Pharma", "Healthcare"],
    ["GLENMARK", "Glenmark Pharmaceuticals", "Healthcare"],
    ["ALKEM", "Alkem Laboratories", "Healthcare"],
    ["IPCALAB", "Ipca Laboratories", "Healthcare"],
    ["SYNGENE", "Syngene International", "Healthcare"],
    ["BIOCON", "Biocon Limited", "Healthcare"],
    ["LAURUSLABS", "Laurus Labs", "Healthcare"],
    ["GRANULES", "Granules India", "Healthcare"],
    ["NATCOPHARM", "Natco Pharma", "Healthcare"],
    ["AJANTPHARM", "Ajanta Pharma", "Healthcare"],
    ["APOLLOHOSP", "Apollo Hospitals", "Healthcare"],
    ["FORTIS", "Fortis Healthcare", "Healthcare"],
    ["MAXHEALTH", "Max Healthcare", "Healthcare"],
    ["MEDANTA", "Global Health (Medanta)", "Healthcare"],
    /* Metals & Mining */
    ["TATASTEEL", "Tata Steel", "Metals & Mining"],
    ["JSWSTEEL", "JSW Steel", "Metals & Mining"],
    ["HINDALCO", "Hindalco Industries", "Metals & Mining"],
    ["VEDL", "Vedanta Limited", "Metals & Mining"],
    ["COALINDIA", "Coal India", "Metals & Mining"],
    ["NMDC", "NMDC Limited", "Metals & Mining"],
    ["SAIL", "Steel Authority of India", "Metals & Mining"],
    ["JINDALSTEL", "Jindal Steel & Power", "Metals & Mining"],
    ["HINDZINC", "Hindustan Zinc", "Metals & Mining"],
    ["NATIONALUM", "National Aluminium", "Metals & Mining"],
    ["APLAPOLLO", "APL Apollo Tubes", "Metals & Mining"],
    ["MOIL", "MOIL Limited", "Metals & Mining"],
    ["WELCORP", "Welspun Corp", "Metals & Mining"],
    ["JSL", "Jindal Stainless", "Metals & Mining"],
    ["HINDCOPPER", "Hindustan Copper", "Metals & Mining"],
    /* Cement */
    ["ULTRACEMCO", "UltraTech Cement", "Cement"],
    ["AMBUJACEM", "Ambuja Cements", "Cement"],
    ["ACC", "ACC Limited", "Cement"],
    ["SHREECEM", "Shree Cement", "Cement"],
    ["DALBHARAT", "Dalmia Bharat", "Cement"],
    ["JKCEMENT", "JK Cement", "Cement"],
    ["RAMCOCEM", "Ramco Cements", "Cement"],
    /* Capital Goods */
    ["SIEMENS", "Siemens Limited", "Capital Goods"],
    ["ABB", "ABB India", "Capital Goods"],
    ["BHEL", "Bharat Heavy Electricals", "Capital Goods"],
    ["CGPOWER", "CG Power & Industrial", "Capital Goods"],
    ["THERMAX", "Thermax Limited", "Capital Goods"],
    ["AIAENG", "AIA Engineering", "Capital Goods"],
    ["HAL", "Hindustan Aeronautics", "Capital Goods"],
    ["BEL", "Bharat Electronics", "Capital Goods"],
    ["BDL", "Bharat Dynamics", "Capital Goods"],
    ["MAZDOCK", "Mazagon Dock Shipbuilders", "Capital Goods"],
    ["COCHINSHIP", "Cochin Shipyard", "Capital Goods"],
    ["GRSE", "Garden Reach Shipbuilders", "Capital Goods"],
    ["DATAPATTNS", "Data Patterns", "Capital Goods"],
    ["CUMMINSIND", "Cummins India", "Capital Goods"],
    ["POLYCAB", "Polycab India", "Capital Goods"],
    ["KEI", "KEI Industries", "Capital Goods"],
    ["SCHAEFFLER", "Schaeffler India", "Capital Goods"],
    ["TIMKEN", "Timken India", "Capital Goods"],
    ["SKFINDIA", "SKF India", "Capital Goods"],
    ["SOLARINDS", "Solar Industries India", "Capital Goods"],
    /* Chemicals */
    ["PIDILITIND", "Pidilite Industries", "Chemicals"],
    ["ASIANPAINT", "Asian Paints", "Chemicals"],
    ["BERGEPAINT", "Berger Paints India", "Chemicals"],
    ["KANSAINER", "Kansai Nerolac Paints", "Chemicals"],
    ["SRF", "SRF Limited", "Chemicals"],
    ["PIIND", "PI Industries", "Chemicals"],
    ["UPL", "UPL Limited", "Chemicals"],
    ["DEEPAKNTR", "Deepak Nitrite", "Chemicals"],
    ["TATACHEM", "Tata Chemicals", "Chemicals"],
    ["AARTIIND", "Aarti Industries", "Chemicals"],
    ["NAVINFLUOR", "Navin Fluorine", "Chemicals"],
    ["FLUOROCHEM", "Gujarat Fluorochemicals", "Chemicals"],
    ["ATUL", "Atul Limited", "Chemicals"],
    ["VINATIORGA", "Vinati Organics", "Chemicals"],
    ["SUMICHEM", "Sumitomo Chemical India", "Chemicals"],
    /* Telecommunication */
    ["IDEA", "Vodafone Idea", "Telecommunication"],
    ["TATACOMM", "Tata Communications", "Telecommunication"],
    ["HFCL", "HFCL Limited", "Telecommunication"],
    ["TEJASNET", "Tejas Networks", "Telecommunication"],
    ["ITI", "ITI Limited", "Telecommunication"],
    /* Realty */
    ["DLF", "DLF Limited", "Realty"],
    ["GODREJPROP", "Godrej Properties", "Realty"],
    ["OBEROIRLTY", "Oberoi Realty", "Realty"],
    ["PRESTIGE", "Prestige Estates", "Realty"],
    ["BRIGADE", "Brigade Enterprises", "Realty"],
    ["PHOENIXLTD", "Phoenix Mills", "Realty"],
    ["LODHA", "Macrotech Developers (Lodha)", "Realty"],
    ["ANANTRAJ", "Anant Raj", "Realty"],
    /* Logistics */
    ["ADANIPORTS", "Adani Ports & SEZ", "Logistics"],
    ["CONCOR", "Container Corporation", "Logistics"],
    ["DELHIVERY", "Delhivery Limited", "Logistics"],
    ["BLUEDART", "Blue Dart Express", "Logistics"],
    ["GATEWAY", "Gateway Distriparks", "Logistics"],
    ["TITAGARH", "Titagarh Rail Systems", "Logistics"],
    /* Media */
    ["SUNTV", "Sun TV Network", "Media"],
    ["ZEEL", "Zee Entertainment", "Media"],
    ["NETWORK18", "Network18 Media", "Media"],
    /* Diversified */
    ["GRASIM", "Grasim Industries", "Diversified"],
    ["TATAINVEST", "Tata Investment Corporation", "Diversified"]
  ];

  const STOCKS = [
    {
      sym: "RELIANCE", name: "Reliance Industries", sector: "Oil Gas & Consumable Fuels",
      color: "#0a5cd6", bse: "500325", seed: 11,
      anchors: [[0, 2380], [0.30, 2620], [0.42, 2280], [0.62, 2980], [0.80, 1310], [0.86, 1560], [1, 1542]],
      vol: 0.030, adv: 9500000, faceValue: 10, beta: 1.05,
      about: "India's largest private-sector company, spanning energy (refining, petchem, O2C), organised retail (Reliance Retail), digital services (Jio Platforms) and new energy. Home to India's largest customer base across Jio and Retail.",
      tags: ["Large Cap", "Conglomerate", "Dividend"],
      f: { mcap: 2085000, pe: 25.8, sectorPe: 18.4, pb: 2.2, divYield: 0.38, eps: 59.8, bookValue: 701, roce: 10.2, roe: 9.6, de: 0.44, promoter: 50.1, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [339840, 539238, 700326, 839420, 964262],
        pat: [53706, 67820, 66702, 69621, 81309],
        margin: [18.5, 19.2, 17.8, 16.5, 17.9],
        eps: [80.0, 100.9, 98.4, 102.7, 119.9]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [50.3, 50.3, 50.1, 50.1, 50.1],
        fii: [21.8, 21.2, 20.4, 19.6, 19.1],
        dii: [16.9, 17.6, 18.5, 19.3, 19.8],
        govt: [0.9, 0.9, 0.9, 0.9, 0.9],
        public: [10.1, 10.0, 10.1, 10.1, 10.1]
      },
      pros: [
        "Jio and Retail anchor two of India's largest consumer franchises with strong pricing power",
        "New energy giga-factories (solar, battery, green hydrogen) offer a long-duration growth option",
        "Consistent deleveraging; net debt comfortable relative to EBITDA after the 2020 fundraise",
        "O2C segment generates robust, counter-cyclical cash flows"
      ],
      cons: [
        "Return ratios (ROE ~9-10%) lag consumer and private-bank peers",
        "Earnings remain sensitive to refining/petchem margin cycles and GRM volatility",
        "Capex cycle across new energy and 5G keeps free cash flow muted near term",
        "Complex holding structure; value-unlocking catalysts have taken longer than expected"
      ]
    },
    {
      sym: "TCS", name: "Tata Consultancy Services", sector: "Information Technology",
      color: "#00594c", bse: "532540", seed: 22,
      anchors: [[0, 3900], [0.10, 3550], [0.35, 3200], [0.55, 3900], [0.75, 4180], [0.88, 3420], [1, 3052]],
      vol: 0.024, adv: 2800000, faceValue: 1, beta: 0.62,
      about: "India's largest IT services company and among the world's biggest software exporters, serving banking, retail, telecom and manufacturing clients across 150+ countries. Known for best-in-class margins and industry-leading dividend payouts.",
      tags: ["Large Cap", "IT Services", "Dividend", "Defensive"],
      f: { mcap: 1106000, pe: 23.4, sectorPe: 26.8, pb: 12.6, divYield: 1.62, eps: 130.4, bookValue: 242, roce: 63.8, roe: 51.2, de: 0.09, promoter: 71.8, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [164813, 191754, 225358, 240893, 255324],
        pat: [32430, 38327, 42087, 45908, 48797],
        margin: [26.5, 25.3, 24.4, 24.5, 24.8],
        eps: [87.5, 104.3, 114.7, 125.4, 133.6]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [71.8, 71.8, 71.8, 71.8, 71.8],
        fii: [12.4, 12.1, 11.6, 11.2, 10.9],
        dii: [10.9, 11.3, 11.9, 12.4, 12.8],
        govt: [1.2, 1.2, 1.2, 1.2, 1.2],
        public: [3.7, 3.6, 3.5, 3.4, 3.3]
      },
      pros: [
        "Industry-best operating margins (~25%) and ROE above 50%",
        "Deep, sticky enterprise relationships; largest deal book in Indian IT",
        "Consistent dividend payout of ~80-100% of EPS — a rare income compounder",
        "Virtually debt-free balance sheet with a large cash chest"
      ],
      cons: [
        "Discretionary tech spend in BFSI and retail remains soft, capping growth",
        "AI-led pricing pressure on legacy application maintenance work",
        "Valuation premium limits upside if growth stays mid-single-digit",
        "High dependence on the US and Europe for the bulk of revenue"
      ]
    },
    {
      sym: "HDFCBANK", name: "HDFC Bank", sector: "Financial Services",
      color: "#00437a", bse: "500180", seed: 33,
      anchors: [[0, 1470], [0.25, 1350], [0.45, 1580], [0.60, 1680], [0.72, 1520], [0.85, 1930], [1, 1984]],
      vol: 0.022, adv: 14000000, faceValue: 1, beta: 0.92,
      about: "India's largest private-sector bank by assets, formed after the landmark merger with HDFC Ltd in July 2023. A full-service bank spanning retail, corporate banking, cards and mortgages with a track record of best-in-class asset quality.",
      tags: ["Large Cap", "Banking", "Dividend"],
      f: { mcap: 1512000, pe: 19.6, sectorPe: 15.2, pb: 2.9, divYield: 1.08, eps: 101.2, bookValue: 684, roce: 7.4, roe: 16.9, de: 6.1, promoter: 0, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [155462, 186864, 223481, 265312, 304876],
        pat: [31217, 36961, 44526, 60812, 67347],
        margin: [4.1, 4.0, 4.1, 3.6, 3.5],
        eps: [56.5, 64.9, 74.4, 96.7, 101.2]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [0, 0, 0, 0, 0],
        fii: [47.8, 47.1, 46.4, 45.9, 45.2],
        dii: [33.5, 34.4, 35.3, 36.1, 36.9],
        govt: [0, 0, 0, 0, 0],
        public: [18.7, 18.5, 18.3, 18.0, 17.9]
      },
      pros: [
        "Best-in-class asset quality with GNPA consistently near 1%",
        "Merger unlocks mortgage cross-sell across a 90M+ customer base",
        "Deposit franchise is the strongest in Indian banking — a moat in a tight-liquidity cycle",
        "Loan growth re-accelerating toward 15% as LDR normalises"
      ],
      cons: [
        "Post-merger LDR dip weighed on NIM; margin recovery is gradual",
        "ROE (~17%) still below the historical ~19% peak",
        "Branch expansion costs keep opex ratio elevated",
        "Premium valuation leaves little room for execution missteps"
      ]
    },
    {
      sym: "INFY", name: "Infosys", sector: "Information Technology",
      color: "#007cc3", bse: "500209", seed: 44,
      anchors: [[0, 1680], [0.12, 1750], [0.35, 1350], [0.55, 1520], [0.75, 1980], [0.90, 1720], [1, 1563]],
      vol: 0.026, adv: 7000000, faceValue: 5, beta: 0.78,
      about: "India's second-largest IT services firm, a global leader in next-generation digital consulting and engineering. Pioneer of India's IT story with a strong balance sheet, generous buybacks and among the highest dividend yields in large-cap IT.",
      tags: ["Large Cap", "IT Services", "Dividend"],
      f: { mcap: 648000, pe: 23.1, sectorPe: 26.8, pb: 8.1, divYield: 2.31, eps: 67.7, bookValue: 193, roce: 41.5, roe: 32.1, de: 0.09, promoter: 14.7, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [100472, 121343, 138564, 153870, 167082],
        pat: [19423, 22110, 24108, 27008, 29231],
        margin: [24.0, 23.0, 21.5, 20.7, 21.6],
        eps: [45.6, 52.0, 56.6, 63.4, 68.6]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [14.7, 14.7, 14.7, 14.7, 14.7],
        fii: [33.9, 33.2, 32.4, 31.8, 31.1],
        dii: [36.4, 37.2, 38.1, 38.9, 39.7],
        govt: [0.9, 0.9, 0.9, 0.9, 0.9],
        public: [14.1, 14.0, 13.9, 13.7, 13.6]
      },
      pros: [
        "Strong free cash flow conversion (~85%+) funding buybacks and dividends",
        "Top-decile digital capabilities; large deals ramping well",
        "Dividend yield above 2% — highest among Indian IT large caps",
        "Net cash balance sheet provides downside cushion"
      ],
      cons: [
        "Revenue guidance cuts in recent cycles dented investor confidence",
        "Exposure to discretionary programs makes growth cyclical",
        "Attrition and wage hikes pressure the margin trajectory",
        "Promoter stake is low (14.7%); stock trades on global macro sentiment"
      ]
    },
    {
      sym: "ICICIBANK", name: "ICICI Bank", sector: "Financial Services",
      color: "#f37e20", bse: "532174", seed: 55,
      anchors: [[0, 700], [0.30, 760], [0.50, 940], [0.70, 1180], [0.85, 1420], [1, 1471]],
      vol: 0.024, adv: 12000000, faceValue: 2, beta: 1.02,
      about: "India's second-largest private bank and one of the market's standout turnaround stories — from asset-quality stress in 2016-18 to sector-leading profitability, with best-in-class ROE and a fast-growing digital ecosystem (iMobile, InstaBIZ).",
      tags: ["Large Cap", "Banking", "Growth"],
      f: { mcap: 1038000, pe: 18.9, sectorPe: 15.2, pb: 3.3, divYield: 0.76, eps: 77.8, bookValue: 446, roce: 7.8, roe: 18.4, de: 5.8, promoter: 0, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [110118, 128462, 147318, 168429, 190246],
        pat: [16212, 23339, 31114, 40888, 47516],
        margin: [2.9, 3.0, 3.4, 4.2, 4.1],
        eps: [23.4, 33.2, 44.1, 57.9, 67.3]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [0, 0, 0, 0, 0],
        fii: [44.6, 44.1, 43.5, 42.9, 42.3],
        dii: [38.2, 39.0, 39.9, 40.7, 41.5],
        govt: [0, 0, 0, 0, 0],
        public: [17.2, 16.9, 16.6, 16.4, 16.2]
      },
      pros: [
        "Sector-leading profitability: ROE ~18% with GNPA near 1.6%",
        "Best-in-class loan growth (~14-16%) across retail, SME and corporate",
        "Turnaround credibility — five straight years of improving asset quality",
        "Strong capital adequacy (~16% CET1) funds growth without dilution"
      ],
      cons: [
        "NIMs have peaked with the rate cycle; incremental margin upside is limited",
        "Unsecured retail and SME books grow fast — watch slippages in a slowdown",
        "Subsidiaries (insurance, AMC) are listed rivals for capital allocation",
        "Re-rating already delivered; expectations are now high"
      ]
    },
    {
      sym: "HINDUNILVR", name: "Hindustan Unilever", sector: "Fast Moving Consumer Goods",
      color: "#00539f", bse: "500696", seed: 66,
      anchors: [[0, 2480], [0.20, 2200], [0.40, 2560], [0.60, 2740], [0.80, 2360], [1, 2384]],
      vol: 0.018, adv: 1600000, faceValue: 1, beta: 0.48,
      about: "India's largest FMCG company — soaps, detergents, shampoos, tea, coffee, ice-cream and premium beauty — touching 9 out of 10 Indian households. Parent Unilever plc holds ~61%. The classic defensive compounder of the Indian market.",
      tags: ["Large Cap", "FMCG", "Defensive", "Dividend"],
      f: { mcap: 559000, pe: 51.2, sectorPe: 47.6, pb: 10.4, divYield: 1.81, eps: 46.6, bookValue: 229, roce: 26.1, roe: 20.4, de: 0.03, promoter: 61.9, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [40432, 46479, 50009, 54182, 57112],
        pat: [6587, 7855, 9066, 9974, 10612],
        margin: [22.5, 23.5, 23.8, 23.4, 23.9],
        eps: [27.9, 33.3, 38.4, 42.3, 45.0]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [61.9, 61.9, 61.9, 61.9, 61.9],
        fii: [12.8, 12.5, 12.1, 11.8, 11.5],
        dii: [13.9, 14.3, 14.8, 15.2, 15.6],
        govt: [0.4, 0.4, 0.4, 0.4, 0.4],
        public: [11.0, 10.9, 10.8, 10.7, 10.6]
      },
      pros: [
        "Unmatched distribution: 8M+ outlets, deep rural reach",
        "Powerhouse brands (Surf, Rin, Lifebuoy, Dove, Kwality Wall's) with pricing power",
        "Defensive earnings — FMCG demand is resilient across cycles",
        "Consistent dividend payer with a healthy payout ratio"
      ],
      cons: [
        "Valuation is rich (~50x earnings) versus mid-single-digit volume growth",
        "Urban demand slowdown and weak rural recovery have capped growth",
        "Input-cost inflation (crude, palm oil) squeezes gross margins",
        "Emerging competition from D2C brands in premium niches"
      ]
    },
    {
      sym: "ITC", name: "ITC Limited", sector: "Fast Moving Consumer Goods",
      color: "#1c4e9a", bse: "500875", seed: 77,
      anchors: [[0, 210], [0.25, 230], [0.45, 330], [0.65, 410], [0.80, 460], [0.90, 395], [1, 415]],
      vol: 0.020, adv: 11000000, faceValue: 1, beta: 0.66,
      about: "A diversified FMCG major — cigarettes (market leader), packaged foods, personal care, education & stationery, agri-business, hotels and paperboards. Famous for its cash-rich cigarette engine funding FMCG scale-up, and among the highest dividend yields in the Nifty 50.",
      tags: ["Large Cap", "FMCG", "High Dividend", "Value"],
      f: { mcap: 518000, pe: 24.6, sectorPe: 47.6, pb: 7.0, divYield: 3.42, eps: 16.9, bookValue: 59.2, roce: 36.4, roe: 28.3, de: 0.00, promoter: 0, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [49861, 57238, 62184, 66428, 71042],
        pat: [13161, 15294, 18934, 20616, 21518],
        margin: [30.5, 32.0, 33.5, 33.0, 33.6],
        eps: [10.5, 12.2, 15.1, 16.4, 17.1]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [0, 0, 0, 0, 0],
        fii: [41.2, 40.6, 39.8, 39.1, 38.5],
        dii: [43.1, 43.9, 44.8, 45.6, 46.3],
        govt: [1.6, 1.6, 1.6, 1.6, 1.6],
        public: [14.1, 13.9, 13.8, 13.7, 13.6]
      },
      pros: [
        "Exceptional dividend yield (~3.4%) backed by huge free cash flow",
        "Cigarette business is a near-monopoly cash machine with pricing power",
        "FMCG others segment now ₹20,000+ Cr revenue and profitable",
        "Zero debt; hotels demerger sharpens the core story"
      ],
      cons: [
        "Regulatory overhang on tobacco (taxation, plain packaging risk)",
        "Cigarettes still drive the bulk of profits — concentration risk",
        "FMCG others margins remain well below cigarette margins",
        "Slower earnings growth versus consumer discretionary peers"
      ]
    },
    {
      sym: "SBIN", name: "State Bank of India", sector: "Financial Services",
      color: "#2d5ea8", bse: "500112", seed: 88,
      anchors: [[0, 430], [0.30, 470], [0.50, 590], [0.70, 780], [0.85, 820], [1, 892]],
      vol: 0.028, adv: 18000000, faceValue: 1, beta: 1.28,
      about: "India's largest bank — a sovereign-backed institution with a 250-year legacy, ~22,000 branches and a dominant share of deposits. The PSU banking flagship, now delivering record profits after a decade-long clean-up of bad loans.",
      tags: ["Large Cap", "PSU", "Banking", "Value"],
      f: { mcap: 796000, pe: 10.4, sectorPe: 15.2, pb: 1.8, divYield: 1.72, eps: 85.8, bookValue: 496, roce: 6.9, roe: 19.2, de: 7.2, promoter: 57.5, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [262341, 300872, 341265, 389412, 421876],
        pat: [20410, 31676, 57535, 61695, 70901],
        margin: [3.2, 3.2, 3.6, 3.9, 3.5],
        eps: [22.8, 35.4, 64.3, 69.0, 79.3]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [57.5, 57.5, 57.5, 57.5, 57.5],
        fii: [10.8, 10.5, 10.1, 9.8, 9.5],
        dii: [22.4, 22.9, 23.5, 24.0, 24.6],
        govt: [0, 0, 0, 0, 0],
        public: [9.3, 9.1, 8.9, 8.7, 8.4]
      },
      pros: [
        "Record profits: PAT up ~3.5x in four years",
        "Cheapest large-cap bank on P/B (~1.8x) with improving ROE (~19%)",
        "Dominant low-cost deposit franchise (CASA ~40%)",
        "Government ownership removes solvency risk; capital raise is easy"
      ],
      cons: [
        "PSU governance and pace of decision-making lag private banks",
        "Legacy corporate book still carries some stressed assets",
        "Treasury gains (bond mark-to-market) add earnings volatility",
        "Occasional capital-raise overhang dilutes minority shareholders"
      ]
    },
    {
      sym: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecommunication",
      color: "#e4002b", bse: "532454", seed: 99,
      anchors: [[0, 640], [0.20, 700], [0.40, 830], [0.60, 1080], [0.80, 1620], [1, 1873]],
      vol: 0.026, adv: 9000000, faceValue: 5, beta: 0.86,
      about: "India's second-largest telecom operator and a global carrier spanning 15+ countries across South Asia and Africa. The 2021-24 tariff hikes transformed industry economics, and Airtel's premium subscriber strategy (ARPU-led) is delivering record earnings.",
      tags: ["Large Cap", "Telecom", "Growth"],
      f: { mcap: 1118000, pe: 54.8, sectorPe: 61.2, pb: 11.8, divYield: 0.51, eps: 34.2, bookValue: 159, roce: 12.6, roe: 21.8, de: 1.32, promoter: 53.2, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [104044, 116955, 139135, 152026, 168412],
        pat: [5942, 8216, 13012, 24822, 33518],
        margin: [26.0, 28.1, 32.4, 40.2, 44.1],
        eps: [10.1, 13.9, 21.8, 41.5, 55.9]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [53.2, 53.2, 53.2, 53.2, 53.2],
        fii: [24.1, 23.6, 23.0, 22.5, 22.0],
        dii: [16.8, 17.3, 17.9, 18.4, 18.9],
        govt: [3.9, 3.9, 3.9, 3.9, 3.9],
        public: [2.0, 2.0, 2.0, 2.0, 2.0]
      },
      pros: [
        "Tariff-led ARPU expansion driving a step-change in profitability",
        "Premium subscriber strategy: highest postpaid and broadband share",
        "Africa and Homes (fibre) businesses compounding nicely",
        "Spectrum payments front-loaded — FCF inflecting upward"
      ],
      cons: [
        "Still expensive on P/E (~55x) versus historical telecom multiples",
        "High debt (~₹1.1L Cr) and lease liabilities from spectrum",
        "Tariff hikes depend on a rational three-player market holding",
        "5G capex and returns timeline remain uncertain"
      ]
    },
    {
      sym: "LT", name: "Larsen & Toubro", sector: "Construction",
      color: "#0057a4", bse: "500510", seed: 110,
      anchors: [[0, 1750], [0.30, 1820], [0.50, 2180], [0.70, 2950], [0.85, 3620], [1, 3641]],
      vol: 0.024, adv: 2200000, faceValue: 2, beta: 1.12,
      about: "India's engineering and construction giant — EPC projects, infrastructure, defence, heavy machinery (via LTIMindtree and LTTS in IT). The primary play on India's capex cycle: metros, airports, highways, defence orders and green energy.",
      tags: ["Large Cap", "Infra", "Capex Play"],
      f: { mcap: 500000, pe: 32.8, sectorPe: 29.4, pb: 6.2, divYield: 0.92, eps: 111.0, bookValue: 587, roce: 15.1, roe: 18.9, de: 1.05, promoter: 0, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [135098, 155924, 183542, 221113, 255124],
        pat: [7255, 8856, 10489, 15013, 18126],
        margin: [10.5, 10.8, 11.0, 11.5, 12.0],
        eps: [52.1, 63.6, 75.3, 107.8, 130.2]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [0, 0, 0, 0, 0],
        fii: [26.1, 25.7, 25.2, 24.8, 24.3],
        dii: [38.9, 39.5, 40.2, 40.8, 41.4],
        govt: [0.9, 0.9, 0.9, 0.9, 0.9],
        public: [34.1, 33.9, 33.7, 33.5, 33.4]
      },
      pros: [
        "Record order book (₹5L+ Cr) giving multi-year revenue visibility",
        "Direct beneficiary of government capex, defence indigenisation and energy transition",
        "IT subsidiaries (LTIMindtree, LTTS) add a quality tech kicker",
        "Improving core margins as the project mix shifts to higher-value EPC"
      ],
      cons: [
        "Working-capital heavy business; cash conversion is lumpy",
        "Execution risk on mega-projects (delays, commodity swings)",
        "Middle-East revenue (~30%) exposes it to oil-linked cycles",
        "Valuation near historic highs after a strong re-rating"
      ]
    },
    {
      sym: "TATAMOTORS", name: "Tata Motors", sector: "Automobile",
      color: "#1b1b1b", bse: "500570", seed: 121,
      anchors: [[0, 460], [0.15, 300], [0.35, 420], [0.55, 640], [0.75, 990], [0.88, 720], [1, 782]],
      vol: 0.038, adv: 16000000, faceValue: 2, beta: 1.52,
      about: "India's leading automobile manufacturer — commercial vehicles leader, passenger vehicles (Nexon, Punch, Harrier) and the EV pioneer of India, plus luxury icon Jaguar Land Rover. Post the 2025 demerger, the CV and PV businesses are separately listed entities under one group.",
      tags: ["Large Cap", "Auto", "EV", "Turnaround"],
      f: { mcap: 288000, pe: 10.9, sectorPe: 22.6, pb: 2.9, divYield: 0.71, eps: 71.7, bookValue: 269, roce: 19.8, roe: 30.2, de: 0.68, promoter: 42.6, pledge: 0.9 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [241826, 278452, 344827, 436475, 462183],
        pat: [-13460, -11406, 4207, 22563, 26489],
        margin: [6.5, 8.0, 11.2, 13.8, 14.2],
        eps: [-37.4, -31.7, 11.4, 61.2, 71.9]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [42.6, 42.6, 42.6, 42.6, 42.6],
        fii: [18.6, 18.1, 17.5, 17.0, 16.5],
        dii: [17.2, 17.7, 18.3, 18.8, 19.3],
        govt: [1.1, 1.1, 1.1, 1.1, 1.1],
        public: [20.5, 20.5, 20.5, 20.5, 20.5]
      },
      pros: [
        "Spectacular turnaround: from losses to record profits in three years",
        "EV leadership in passenger vehicles (~70% share of e-PV sales)",
        "JLR is firing with strong demand, pricing and margin recovery",
        "Net-cash balance sheet after years of deleveraging"
      ],
      cons: [
        "Cyclical: CV and PV demand is rate- and economy-sensitive",
        "JLR exposes it to China demand and UK/EU macro shocks",
        "Post-demerger structure adds complexity for investors",
        "Small promoter pledge exists; EV competition intensifying"
      ]
    },
    {
      sym: "ADANIENT", name: "Adani Enterprises", sector: "Diversified",
      color: "#0072bc", bse: "512599", seed: 132,
      anchors: [[0, 1340], [0.18, 2760], [0.30, 4180], [0.36, 2320], [0.42, 2980], [0.60, 3140], [0.80, 2380], [1, 2352]],
      vol: 0.055, adv: 3500000, faceValue: 1, beta: 1.85,
      about: "The incubator of the Adani group — airports, green hydrogen, roads, defence and the core resources/trading business. The highest-beta large cap in India: a 2.5x surge into 2022, the 2023 short-seller shock, and a subsequent recovery make it a case study in volatility.",
      tags: ["Large Cap", "Conglomerate", "High Beta"],
      f: { mcap: 269000, pe: 37.6, sectorPe: 24.1, pb: 4.5, divYield: 0.05, eps: 62.6, bookValue: 523, roce: 11.8, roe: 12.4, de: 1.12, promoter: 72.6, pledge: 1.2 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [62829, 71032, 83086, 96107, 108241],
        pat: [988, 4615, 8209, 6874, 7812],
        margin: [12.0, 18.1, 24.2, 20.1, 21.3],
        eps: [8.7, 40.6, 72.3, 60.6, 68.8]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [72.6, 72.6, 72.6, 72.6, 72.6],
        fii: [14.8, 14.2, 13.6, 13.1, 12.7],
        dii: [5.9, 6.3, 6.8, 7.2, 7.6],
        govt: [0.3, 0.3, 0.3, 0.3, 0.3],
        public: [6.4, 6.6, 6.7, 6.8, 6.8]
      },
      pros: [
        "Unique incubation model: airports, green H2 and roads are option-value businesses",
        "Airports platform is India's largest by passenger traffic",
        "Strong execution track record in building infrastructure at speed",
        "Group balance sheet repaired post-2023; maturities pre-paid"
      ],
      cons: [
        "Extreme volatility — drawdowns of 50%+ have occurred (2023 short-seller episode)",
        "Small dividend; returns depend entirely on price, not income",
        "High leverage at operating companies; funding needs are perpetual",
        "Governance and disclosure standards remain a live debate"
      ]
    },
    {
      sym: "ESDS", name: "ESDS Software Solution", sector: "Information Technology",
      color: "#0e7c86", bse: "544105", seed: 143,
      anchors: [[0, 318], [0.15, 275], [0.35, 355], [0.55, 420], [0.75, 505], [0.90, 452], [1, 468]],
      vol: 0.032, adv: 1800000, faceValue: 10, beta: 1.35,
      about: "ESDS Software Solution is a Navi Mumbai-based cloud and data-centre services company — India's home-grown alternative to the global hyperscalers. It runs colocation facilities and a managed cloud platform (Nevvy) serving BFSI, government and enterprise customers, alongside SAP hosting, CDN and disaster-recovery services.",
      tags: ["Mid Cap", "IT Services", "Data Centres"],
      f: { mcap: 12480, pe: 34.2, sectorPe: 26.0, pb: 5.8, divYield: 0.3, eps: 26.4, bookValue: 145, roce: 17.6, roe: 15.9, de: 0.38, promoter: 52.3, pledge: 0 },
      fin: {
        years: ["FY21", "FY22", "FY23", "FY24", "FY25"],
        revenue: [382, 474, 496, 560, 655],
        pat: [42, 61, 60, 77, 105],
        margin: [11.0, 12.9, 12.1, 13.8, 16.0],
        eps: [10.6, 15.4, 15.2, 19.5, 26.6]
      },
      sh: {
        quarters: ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"],
        promoter: [52.3, 52.3, 52.0, 51.8, 51.6],
        fii: [8.2, 8.8, 9.4, 10.1, 10.6],
        dii: [3.1, 3.4, 3.8, 4.2, 4.6],
        govt: [0.4, 0.4, 0.4, 0.4, 0.4],
        public: [36.0, 35.1, 34.4, 33.5, 32.8]
      },
      pros: [
        "Owns data centres in Mumbai, Bengaluru and Navi Mumbai with hyperscale-ready capacity",
        "Nevvy cloud platform lets enterprises orchestrate private and public cloud seamlessly",
        "High-margin managed services (SAP hosting, DRaaS, CDN) give recurring revenue",
        "Debt-light balance sheet funds capacity expansion largely from internal cash flows"
      ],
      cons: [
        "Hyperscalers (AWS, Azure, GCP) keep compressing hosting and cloud prices",
        "Client concentration in BFSI and government contracts; long sales cycles",
        "Capex-heavy model — returns depend on data-centre utilisation ramp-ups",
        "Smaller scale limits bargaining power on power, land and network costs"
      ]
    }
  ];

  /* ============================================================
     UNIVERSE EXPANSION
     Every UNIVERSE_META symbol that isn't a curated stock above
     becomes a full record with deterministic (seeded) illustrative
     fundamentals and a plausible price path. Live prices from
     server.py replace the last point at runtime (see js/live.js).
     ============================================================ */
  const PALETTE = ["#0071e3", "#30d158", "#ff9f0a", "#5856d6", "#e30000", "#0e7c86",
                   "#b25000", "#8e44ad", "#00a852", "#f37e20", "#1d1d1f", "#007cc3"];
  const SECTOR_PE = {
    "Information Technology": 26, "Financial Services": 16.5, "Oil Gas & Consumable Fuels": 12.5,
    "Fast Moving Consumer Goods": 38, "Telecommunication": 35, "Construction": 24, "Automobile": 22,
    "Diversified": 24, "Healthcare": 28, "Metals & Mining": 10.5, "Cement": 21, "Power": 15.5,
    "Capital Goods": 32, "Chemicals": 24.5, "Consumer Services": 33, "Consumer Durables": 40,
    "Realty": 28, "Logistics": 21, "Media": 20
  };
  const SECTOR_BLURB = {
    "Information Technology": "software services and digital technology",
    "Financial Services": "banking, lending and financial services",
    "Oil Gas & Consumable Fuels": "energy, refining and fuel distribution",
    "Fast Moving Consumer Goods": "consumer staples and packaged brands",
    "Telecommunication": "telecom networks and connectivity",
    "Construction": "engineering and construction",
    "Automobile": "automotive and mobility",
    "Diversified": "multi-business industrial",
    "Healthcare": "pharmaceuticals and healthcare delivery",
    "Metals & Mining": "metals, mining and commodities",
    "Cement": "cement and building materials",
    "Power": "power generation and utilities",
    "Capital Goods": "industrial machinery and defence electronics",
    "Chemicals": "speciality chemicals and materials",
    "Consumer Services": "retail, food service and consumer platforms",
    "Consumer Durables": "consumer appliances and durables",
    "Realty": "real estate development",
    "Logistics": "logistics, ports and transportation",
    "Media": "media and entertainment"
  };

  const GENERIC_PROS = [
    "Market position and brand recognition in its core segment",
    "Diversified customer base across geographies and industries",
    "Consistent operating cash generation funds growth internally",
    "Improving operating leverage as scale builds",
    "Management has a long track record of capital allocation",
    "Balance sheet carries headroom for inorganic growth",
    "Distribution reach is a durable competitive advantage",
    "Regulatory tailwinds support the addressable market",
    "Free-cash-flow conversion has improved over the cycle",
    "Investments in technology and capacity are starting to pay off"
  ];
  const GENERIC_CONS = [
    "Valuation is full relative to sector peers and growth",
    "Input-cost inflation can compress margins quickly",
    "Competitive intensity is rising from larger players",
    "Customer concentration means a few accounts matter a lot",
    "Working-capital cycles are long and cash-hungry",
    "Capex plans raise execution and funding risk",
    "Regulatory or policy changes could alter unit economics",
    "Growth depends on a cyclical end-market recovery",
    "Currency and commodity moves create earnings volatility",
    "Promoter holding leaves limited float for large investors"
  ];

  function pick(arr, rng, n) {
    const copy = arr.slice(), out = [];
    for (let i = 0; i < n && copy.length; i++) {
      out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
    }
    return out;
  }

  function symSeed(sym) {
    let h = 0;
    for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) | 0;
    return (Math.abs(h) % 100000) + 7;
  }

  /* deterministic illustrative record for a universe symbol */
  function buildUniverseStock(sym, name, sector) {
    const seed = symSeed(sym);
    const rng = mulberry32(seed);
    const sPe = SECTOR_PE[sector] || 22;

    /* plausible price path: 6 anchors with drift and wobble */
    const start = 50 + Math.round(rng() * 3200);
    const drift = 0.55 + rng() * 1.6;
    const anchors = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      anchors.push([t, Math.max(8, start * Math.pow(drift, t) * (1 + (rng() - 0.5) * 0.28))]);
    }
    const vol = 0.018 + rng() * 0.032;
    const adv = 120000 + Math.round(Math.pow(rng(), 1.8) * 6500000);
    const price = anchors[5][1] * (1 + (rng() - 0.5) * 0.08);

    const mcap = 4500 + Math.pow(rng(), 1.6) * 260000;
    const shares = mcap * 1e7 / price;
    const pe = Math.max(4, sPe * (0.55 + rng() * 1.2));
    const eps = price / pe;
    const pb = 0.8 + rng() * 7.5;
    const roe = 6 + rng() * 20;
    const roce = Math.min(45, roe * (0.75 + rng() * 0.6));
    const de = Math.round((0.05 + rng() * 1.4) * 100) / 100;
    const promoter = Math.round((22 + rng() * 52) * 10) / 10;
    const tag = mcap > 50000 ? "Large Cap" : mcap > 20000 ? "Mid Cap" : "Small Cap";

    /* FY21–FY25 financials */
    const marginBase = sector === "Financial Services" ? 15 + rng() * 16 : 4 + rng() * 17;
    const growth = 0.03 + rng() * 0.16;
    const rev25 = mcap * (0.3 + rng() * 1.5);
    const revenue = [], pat = [], margin = [], epsHist = [];
    for (let i = 0; i < 5; i++) {
      const rev = rev25 / Math.pow(1 + growth, 4 - i);
      const m = marginBase + (i - 2) * (rng() - 0.4) * 1.8;
      const p = rev * m / 100;
      revenue.push(Math.round(rev));
      pat.push(Math.round(p));
      margin.push(Math.round(m * 10) / 10);
      epsHist.push(Math.round(p * 1e7 / shares * 100) / 100);
    }

    /* 5-quarter shareholding pattern */
    const quarters = ["Jun 25", "Sep 25", "Dec 25", "Mar 26", "Jun 26"];
    const fiiBase = 3 + rng() * 24, diiBase = 2 + rng() * 13;
    const govt = rng() < 0.7 ? Math.round(rng() * 10) / 10 : 0;
    const shProm = [], shFii = [], shDii = [], shPub = [];
    for (let i = 0; i < 5; i++) {
      const pr = promoter + (i - 2) * (rng() - 0.6) * 0.4;
      const fi = fiiBase + i * (0.2 + rng() * 0.5);
      const di = diiBase + i * (0.15 + rng() * 0.4);
      shProm.push(Math.round(pr * 10) / 10);
      shFii.push(Math.round(fi * 10) / 10);
      shDii.push(Math.round(di * 10) / 10);
      shPub.push(Math.round((100 - pr - fi - di - govt) * 10) / 10);
    }

    return {
      sym, name, sector, color: PALETTE[seed % PALETTE.length], seed,
      anchors, vol, adv, faceValue: 10, bse: "—",
      beta: Math.round((0.7 + rng() * 1.3) * 100) / 100,
      about: name + " is a " + (SECTOR_BLURB[sector] || "listed Indian") +
        " company tracked in the Dalal universe. Fundamentals here are illustrative demo values; prices update live when the Dalal server is running.",
      tags: [tag, sector],
      f: {
        mcap: Math.round(mcap), pe: Math.round(pe * 10) / 10, sectorPe: sPe,
        pb: Math.round(pb * 100) / 100, divYield: Math.round(rng() * rng() * 2.8 * 100) / 100,
        eps: Math.round(eps * 100) / 100, bookValue: Math.round(price / pb * 100) / 100,
        roce: Math.round(roce * 10) / 10, roe: Math.round(roe * 10) / 10, de, promoter,
        pledge: rng() < 0.85 ? 0 : Math.round(rng() * 9.9 * 10) / 10
      },
      fin: { years: ["FY21", "FY22", "FY23", "FY24", "FY25"], revenue, pat, margin, eps: epsHist },
      sh: { quarters, promoter: shProm, fii: shFii, dii: shDii,
            govt: [govt, govt, govt, govt, govt], public: shPub },
      pros: pick(GENERIC_PROS, rng, 4),
      cons: pick(GENERIC_CONS, rng, 4)
    };
  }

  /* add every universe symbol that isn't already a curated stock */
  const CURATED = {};
  STOCKS.forEach(s => { CURATED[s.sym] = true; });
  UNIVERSE_META.forEach(m => {
    if (!CURATED[m[0]]) STOCKS.push(buildUniverseStock(m[0], m[1], m[2]));
  });
  const SYM_SET = new Set(STOCKS.map(s => s.sym));

  /* ------------------------------------------------------------
     extendUniverse(list)
     Adds generated records for extra symbols at runtime — used by
     js/live.js to pull the complete NSE list from server.py
     (/api/universe). Entries may be "SYM" or {sym, name, sector}.
     Returns the number of symbols added.
     ------------------------------------------------------------ */
  function extendUniverse(list) {
    let added = 0;
    (list || []).forEach(entry => {
      const arr = Array.isArray(entry);
      const sym = String((typeof entry === "string" ? entry
        : arr ? entry[0] : entry && entry.sym) || "").toUpperCase();
      if (!sym || SYM_SET.has(sym)) return;
      const name = (arr ? entry[1] : (typeof entry === "object" && entry.name)) || sym;
      const sector = (arr ? entry[2] : (typeof entry === "object" && entry.sector)) || "Other";
      const s = buildUniverseStock(sym, name, sector);
      s.series = (typeof entry === "object" && !arr && entry.series) || "EQ";
      s.close = genSeries(s.seed, s.anchors, s.vol);   // attach history now
      s.volume = genVolume(s.seed, s.adv);
      s.stats = statsFor(s.close);
      STOCKS.push(s);
      SYM_SET.add(sym);
      added++;
    });
    return added;
  }

  /* If js/universe_nse.js is present (generated from NSE's official
     EQUITY_L.csv), the complete listing is available even offline. */
  if (Array.isArray(window.DALAL_NSE_UNIVERSE)) {
    try { extendUniverse(window.DALAL_NSE_UNIVERSE); } catch (e) { /* ignore */ }
  }

  /* ---------- attach generated history ---------- */
  INDICES.forEach(ix => {
    ix.close = genSeries(ix.seed, ix.anchors, ix.vol);
  });
  STOCKS.forEach(s => {
    s.close = genSeries(s.seed, s.anchors, s.vol);
    s.volume = genVolume(s.seed, s.adv);
  });

  /* ============================================================
     HELPERS
     ============================================================ */
  const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function fmtPrice(v) { return "₹" + inr2.format(v); }
  function fmtNum(v) { return inr.format(v); }
  function fmtCr(cr) {
    if (cr >= 100000) return "₹" + (cr / 100000).toFixed(2) + " L Cr";
    return "₹" + inr.format(Math.round(cr)) + " Cr";
  }
  function fmtPct(v, sign) {
    const s = sign && v > 0 ? "+" : "";
    return s + v.toFixed(2) + "%";
  }
  function fmtVol(v) {
    if (v >= 10000000) return (v / 10000000).toFixed(2) + " Cr";
    if (v >= 100000) return (v / 100000).toFixed(2) + " L";
    if (v >= 1000) return (v / 1000).toFixed(1) + "K";
    return String(v);
  }
  function fmtDate(iso) {
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  function pctChange(series, back) {
    const n = series.length;
    if (n <= back) return null;
    return (series[n - 1] - series[n - 1 - back]) / series[n - 1 - back] * 100;
  }
  function dayChange(series) {
    const n = series.length;
    const chg = series[n - 1] - series[n - 2];
    return { chg, pct: chg / series[n - 2] * 100 };
  }
  function sma(series, period) {
    const out = new Array(series.length).fill(null);
    let sum = 0;
    for (let i = 0; i < series.length; i++) {
      sum += series[i];
      if (i >= period) sum -= series[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }
  function highLow(series, days) {
    const seg = series.slice(Math.max(0, series.length - days));
    return { high: Math.max(...seg), low: Math.min(...seg) };
  }
  /* SMAs are ~1,300-element arrays each; computing them for every stock in a
     2,500-stock universe wastes memory. They are attached lazily and
     memoised the first time a chart or the stock page asks for them. */
  function lazySMA(st, series, period) {
    Object.defineProperty(st, "sma" + period, {
      configurable: true,
      get() {
        const v = sma(series, period);
        Object.defineProperty(st, "sma" + period, { value: v, configurable: true });
        return v;
      }
    });
  }
  function statsFor(series) {
    const n = series.length;
    const st = {
      last: series[n - 1],
      day: dayChange(series),
      w1: pctChange(series, 5),
      m1: pctChange(series, 21),
      m6: pctChange(series, 126),
      y1: pctChange(series, 251),
      y3: pctChange(series, 756),
      y5: pctChange(series, n - 1),
      hl52: highLow(series, 251)
    };
    lazySMA(st, series, 50);
    lazySMA(st, series, 200);
    return st;
  }
  INDICES.forEach(ix => { ix.stats = statsFor(ix.close); });
  STOCKS.forEach(s => { s.stats = statsFor(s.close); });

  function bySymbol(sym) {
    sym = (sym || "").toUpperCase();
    return STOCKS.find(s => s.sym === sym) || null;
  }
  function indexBySymbol(sym) {
    sym = (sym || "").toUpperCase();
    return INDICES.find(s => s.sym === sym) || null;
  }
  function searchAll(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const res = [];
    STOCKS.forEach(s => {
      if (s.sym.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) res.push({ type: "stock", item: s });
    });
    INDICES.forEach(ix => {
      if (ix.sym.toLowerCase().includes(q) || ix.name.toLowerCase().includes(q)) res.push({ type: "index", item: ix });
    });
    return res.slice(0, 8);
  }

  /* valuation verdict from P/E vs sector P/E + P/B + ROE */
  function valuationVerdict(s) {
    const rel = s.f.pe / s.f.sectorPe;
    if (rel < 0.8) return { label: "Attractive", cls: "b-green", pos: 0.18 };
    if (rel < 1.05) return { label: "Fair", cls: "b-blue", pos: 0.5 };
    if (rel < 1.35) return { label: "Stretched", cls: "b-amber", pos: 0.78 };
    return { label: "Expensive", cls: "b-red", pos: 0.92 };
  }

  /* composite score 0-100 */
  function scoreOf(s) {
    const st = s.stats;
    const parts = {
      Valuation: Math.max(0, Math.min(100, 100 - (s.f.pe / s.f.sectorPe - 0.6) * 90)),
      Growth: Math.max(0, Math.min(100, 50 + (st.y3 || 0) * 1.1)),
      Profitability: Math.max(0, Math.min(100, s.f.roe * 2.1)),
      "Financial Health": Math.max(0, Math.min(100, 100 - s.f.de * 14)),
      Momentum: Math.max(0, Math.min(100, 50 + (st.y1 || 0) * 0.9)),
      Dividend: Math.max(0, Math.min(100, s.f.divYield * 26))
    };
    const weights = { Valuation: 0.22, Growth: 0.2, Profitability: 0.2, "Financial Health": 0.16, Momentum: 0.14, Dividend: 0.08 };
    let total = 0;
    Object.keys(parts).forEach(k => { total += parts[k] * weights[k]; });
    const score = Math.round(total);
    const label = score >= 70 ? "Strong" : score >= 55 ? "Healthy" : score >= 40 ? "Mixed" : "Weak";
    const color = score >= 70 ? "#00a852" : score >= 55 ? "#0071e3" : score >= 40 ? "#b25000" : "#e30000";
    return { parts, score, label, color };
  }

  window.DALAL = {
    DATES, INDICES, STOCKS,
    fmtPrice, fmtNum, fmtCr, fmtPct, fmtVol, fmtDate,
    pctChange, dayChange, sma, highLow, statsFor,
    bySymbol, indexBySymbol, searchAll, valuationVerdict, scoreOf, extendUniverse
  };
})();