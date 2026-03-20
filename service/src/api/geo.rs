use axum::{Json, Router, routing::get};
use serde::Serialize;

use crate::DbPool;

#[derive(Serialize)]
struct CCAAData<'a> {
    id: &'a str,
    name: &'a str,
}

#[derive(Serialize)]
struct ProvinciaData<'a> {
    id: &'a str,
    ccaa: &'a str,
    name: &'a str,
}

const CCAA: [CCAAData; 19] = [
    CCAAData {
        id: "16",
        name: "País Vasco",
    },
    CCAAData {
        id: "12",
        name: "Galicia",
    },
    CCAAData {
        id: "03",
        name: "Asturias",
    },
    CCAAData {
        id: "09",
        name: "Cataluña",
    },
    CCAAData {
        id: "08",
        name: "Castilla y León",
    },
    CCAAData {
        id: "06",
        name: "Cantabria",
    },
    CCAAData {
        id: "13",
        name: "Madrid",
    },
    CCAAData {
        id: "15",
        name: "Navarra",
    },
    CCAAData {
        id: "02",
        name: "Aragón",
    },
    CCAAData {
        id: "10",
        name: "Comunidad Valenciana",
    },
    CCAAData {
        id: "14",
        name: "Murcia",
    },
    CCAAData {
        id: "17",
        name: "La Rioja",
    },
    CCAAData {
        id: "04",
        name: "Islas Baleares",
    },
    CCAAData {
        id: "19",
        name: "Melilla",
    },
    CCAAData {
        id: "18",
        name: "Ceuta",
    },
    CCAAData {
        id: "07",
        name: "Castilla-La Mancha",
    },
    CCAAData {
        id: "01",
        name: "Andalucía",
    },
    CCAAData {
        id: "11",
        name: "Extremadura",
    },
    CCAAData {
        id: "05",
        name: "Islas Canarias",
    },
];

const PROVINCIAS: [ProvinciaData; 52] = [
    ProvinciaData {
        id: "48",
        ccaa: "16",
        name: "BIZKAIA",
    },
    ProvinciaData {
        id: "20",
        ccaa: "16",
        name: "GIPUZKOA",
    },
    ProvinciaData {
        id: "01",
        ccaa: "16",
        name: "ARABA/ÁLAVA",
    },
    ProvinciaData {
        id: "15",
        ccaa: "12",
        name: "CORUÑA (A)",
    },
    ProvinciaData {
        id: "27",
        ccaa: "12",
        name: "LUGO",
    },
    ProvinciaData {
        id: "36",
        ccaa: "12",
        name: "PONTEVEDRA",
    },
    ProvinciaData {
        id: "32",
        ccaa: "12",
        name: "OURENSE",
    },
    ProvinciaData {
        id: "33",
        ccaa: "03",
        name: "ASTURIAS",
    },
    ProvinciaData {
        id: "08",
        ccaa: "09",
        name: "BARCELONA",
    },
    ProvinciaData {
        id: "37",
        ccaa: "08",
        name: "SALAMANCA",
    },
    ProvinciaData {
        id: "39",
        ccaa: "06",
        name: "CANTABRIA",
    },
    ProvinciaData {
        id: "28",
        ccaa: "13",
        name: "MADRID",
    },
    ProvinciaData {
        id: "34",
        ccaa: "08",
        name: "PALENCIA",
    },
    ProvinciaData {
        id: "31",
        ccaa: "15",
        name: "NAVARRA",
    },
    ProvinciaData {
        id: "22",
        ccaa: "02",
        name: "HUESCA",
    },
    ProvinciaData {
        id: "50",
        ccaa: "02",
        name: "ZARAGOZA",
    },
    ProvinciaData {
        id: "44",
        ccaa: "02",
        name: "TERUEL",
    },
    ProvinciaData {
        id: "25",
        ccaa: "09",
        name: "LLEIDA",
    },
    ProvinciaData {
        id: "17",
        ccaa: "09",
        name: "GIRONA",
    },
    ProvinciaData {
        id: "43",
        ccaa: "09",
        name: "TARRAGONA",
    },
    ProvinciaData {
        id: "46",
        ccaa: "10",
        name: "VALENCIA / VALÈNCIA",
    },
    ProvinciaData {
        id: "03",
        ccaa: "10",
        name: "ALICANTE",
    },
    ProvinciaData {
        id: "12",
        ccaa: "10",
        name: "CASTELLÓN / CASTELLÓ",
    },
    ProvinciaData {
        id: "30",
        ccaa: "14",
        name: "MURCIA",
    },
    ProvinciaData {
        id: "26",
        ccaa: "17",
        name: "RIOJA (LA)",
    },
    ProvinciaData {
        id: "07",
        ccaa: "04",
        name: "BALEARS (ILLES)",
    },
    ProvinciaData {
        id: "52",
        ccaa: "19",
        name: "MELILLA",
    },
    ProvinciaData {
        id: "51",
        ccaa: "18",
        name: "CEUTA",
    },
    ProvinciaData {
        id: "13",
        ccaa: "07",
        name: "CIUDAD REAL",
    },
    ProvinciaData {
        id: "19",
        ccaa: "07",
        name: "GUADALAJARA",
    },
    ProvinciaData {
        id: "02",
        ccaa: "07",
        name: "ALBACETE",
    },
    ProvinciaData {
        id: "45",
        ccaa: "07",
        name: "TOLEDO",
    },
    ProvinciaData {
        id: "14",
        ccaa: "01",
        name: "CÓRDOBA",
    },
    ProvinciaData {
        id: "16",
        ccaa: "07",
        name: "CUENCA",
    },
    ProvinciaData {
        id: "24",
        ccaa: "08",
        name: "LEÓN",
    },
    ProvinciaData {
        id: "42",
        ccaa: "08",
        name: "SORIA",
    },
    ProvinciaData {
        id: "09",
        ccaa: "08",
        name: "BURGOS",
    },
    ProvinciaData {
        id: "40",
        ccaa: "08",
        name: "SEGOVIA",
    },
    ProvinciaData {
        id: "47",
        ccaa: "08",
        name: "VALLADOLID",
    },
    ProvinciaData {
        id: "49",
        ccaa: "08",
        name: "ZAMORA",
    },
    ProvinciaData {
        id: "05",
        ccaa: "08",
        name: "ÁVILA",
    },
    ProvinciaData {
        id: "23",
        ccaa: "01",
        name: "JAÉN",
    },
    ProvinciaData {
        id: "29",
        ccaa: "01",
        name: "MÁLAGA",
    },
    ProvinciaData {
        id: "18",
        ccaa: "01",
        name: "GRANADA",
    },
    ProvinciaData {
        id: "21",
        ccaa: "01",
        name: "HUELVA",
    },
    ProvinciaData {
        id: "11",
        ccaa: "01",
        name: "CÁDIZ",
    },
    ProvinciaData {
        id: "04",
        ccaa: "01",
        name: "ALMERÍA",
    },
    ProvinciaData {
        id: "10",
        ccaa: "11",
        name: "CÁCERES",
    },
    ProvinciaData {
        id: "06",
        ccaa: "11",
        name: "BADAJOZ",
    },
    ProvinciaData {
        id: "41",
        ccaa: "01",
        name: "SEVILLA",
    },
    ProvinciaData {
        id: "38",
        ccaa: "05",
        name: "SANTA CRUZ DE TENERIFE",
    },
    ProvinciaData {
        id: "35",
        ccaa: "05",
        name: "PALMAS (LAS)",
    },
];

#[derive(Serialize)]
struct FilterData<'a> {
    ccaa: &'a[CCAAData<'a>],
    provincias: &'a[ProvinciaData<'a>]
}

async fn filter() -> Json<FilterData<'static>> {
    Json(FilterData { ccaa: &CCAA, provincias: &PROVINCIAS })
}


pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/filter", get(filter))
}
