// 宿主页只负责挂脚本，禁止写入可见 DOM（否则点「公文助手」Tab 会盖正文）
document.write("<script language='javascript' src='js/util.js'><\/script>");
document.write("<script language='javascript' src='js/ribbon.js'><\/script>");
